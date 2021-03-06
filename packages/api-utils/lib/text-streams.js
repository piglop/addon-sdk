/* -*- Mode: Java; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*-
 * vim:set ts=2 sw=2 sts=2 et filetype=javascript
 * ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Jetpack.
 *
 * The Initial Developer of the Original Code is
 * the Mozilla Foundation.
 * Portions created by the Initial Developer are Copyright (C) 2010
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Drew Willcoxon <adw@mozilla.com> (Original Author)
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

const {Cc,Ci,Cu,components} = require("chrome");
var NetUtil = {};
Cu.import("resource://gre/modules/NetUtil.jsm", NetUtil);
NetUtil = NetUtil.NetUtil;

// NetUtil.asyncCopy() uses this buffer length, and since we call it, for best
// performance we use it, too.
const BUFFER_BYTE_LEN = 0x8000;
const PR_UINT32_MAX = 0xffffffff;
const DEFAULT_CHARSET = "UTF-8";

exports.TextReader = TextReader;
exports.TextWriter = TextWriter;

/**
 * An input stream that reads text from a backing stream using a given text
 * encoding.
 *
 * @param inputStream
 *        The stream is backed by this nsIInputStream.  It must already be
 *        opened.
 * @param charset
 *        Text in inputStream is expected to be in this character encoding.  If
 *        not given, "UTF-8" is assumed.  See nsICharsetConverterManager.idl for
 *        documentation on how to determine other valid values for this.
 */
function TextReader(inputStream, charset) {
  const self = this;
  charset = checkCharset(charset);

  let stream = Cc["@mozilla.org/intl/converter-input-stream;1"].
               createInstance(Ci.nsIConverterInputStream);
  stream.init(inputStream, charset, BUFFER_BYTE_LEN,
              Ci.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);

  let manager = new StreamManager(this, stream);

  /**
   * Reads a string from the stream.  If the stream is closed, an exception is
   * thrown.
   *
   * @param  numChars
   *         The number of characters to read.  If not given, the remainder of
   *         the stream is read.
   * @return The string read.  If the stream is already at EOS, returns the
   *         empty string.
   */
  this.read = function TextReader_read(numChars) {
    manager.ensureOpened();

    let readAll = false;
    if (typeof(numChars) === "number")
      numChars = Math.max(numChars, 0);
    else
      readAll = true;

    let str = "";
    let totalRead = 0;
    let chunkRead = 1;

    // Read in numChars or until EOS, whichever comes first.  Note that the
    // units here are characters, not bytes.
    while (true) {
      let chunk = {};
      let toRead = readAll ?
                   PR_UINT32_MAX :
                   Math.min(numChars - totalRead, PR_UINT32_MAX);
      if (toRead <= 0 || chunkRead <= 0)
        break;

      // The converter stream reads in at most BUFFER_BYTE_LEN bytes in a call
      // to readString, enough to fill its byte buffer.  chunkRead will be the
      // number of characters encoded by the bytes in that buffer.
      chunkRead = stream.readString(toRead, chunk);
      str += chunk.value;
      totalRead += chunkRead;
    }

    return str;
  };
}

/**
 * A buffered output stream that writes text to a backing stream using a given
 * text encoding.
 *
 * @param outputStream
 *        The stream is backed by this nsIOutputStream.  It must already be
 *        opened.
 * @param charset
 *        Text will be written to outputStream using this character encoding.
 *        If not given, "UTF-8" is assumed.  See nsICharsetConverterManager.idl
 *        for documentation on how to determine other valid values for this.
 */
function TextWriter(outputStream, charset) {
  const self = this;
  charset = checkCharset(charset);

  let stream = outputStream;

  // Buffer outputStream if it's not already.
  let ioUtils = Cc["@mozilla.org/io-util;1"].getService(Ci.nsIIOUtil);
  if (!ioUtils.outputStreamIsBuffered(outputStream)) {
    stream = Cc["@mozilla.org/network/buffered-output-stream;1"].
             createInstance(Ci.nsIBufferedOutputStream);
    stream.init(outputStream, BUFFER_BYTE_LEN);
  }

  // I'd like to use nsIConverterOutputStream.  But NetUtil.asyncCopy(), which
  // we use below in writeAsync(), naturally expects its sink to be an instance
  // of nsIOutputStream, which nsIConverterOutputStream's only implementation is
  // not.  So we use uconv and manually convert all strings before writing to
  // outputStream.
  let uconv = Cc["@mozilla.org/intl/scriptableunicodeconverter"].
              createInstance(Ci.nsIScriptableUnicodeConverter);
  uconv.charset = charset;

  let manager = new StreamManager(this, stream);

  /**
   * Flushes the backing stream's buffer.
   */
  this.flush = function TextWriter_flush() {
    manager.ensureOpened();
    stream.flush();
  };

  /**
   * Writes a string to the stream.  If the stream is closed, an exception is
   * thrown.
   *
   * @param str
   *        The string to write.
   */
  this.write = function TextWriter_write(str) {
    manager.ensureOpened();
    let istream = uconv.convertToInputStream(str);
    let len = istream.available();
    while (len > 0) {
      stream.writeFrom(istream, len);
      len = istream.available();
    }
    istream.close();
  };

  /**
   * Writes a string on a background thread.  After the write completes, the
   * backing stream's buffer is flushed, and both the stream and the backing
   * stream are closed, also on the background thread.  If the stream is already
   * closed, an exception is thrown immediately.
   *
   * @param str
   *        The string to write.
   * @param callback
   *        An optional function.  If given, it's called as callback(error) when
   *        the write completes.  error is an Error object or undefined if there
   *        was no error.  Inside callback, |this| is the stream object.
   */
  this.writeAsync = function TextWriter_writeAsync(str, callback) {
    manager.ensureOpened();
    let istream = uconv.convertToInputStream(str);
    NetUtil.asyncCopy(istream, stream, function (result) {
        let err = components.isSuccessCode(result) ? undefined :
        new Error("An error occured while writing to the stream: " + result);
      if (err)
        console.error(err);

      // asyncCopy() closes its output (and input) stream.
      manager.opened = false;

      if (typeof(callback) === "function") {
        try {
          callback.call(self, err);
        }
        catch (exc) {
          console.exception(exc);
        }
      }
    });
  };
}

// This manages the lifetime of stream, a TextReader or TextWriter.  It defines
// closed and close() on stream and registers an unload listener that closes
// rawStream if it's still opened.  It also provides ensureOpened(), which
// throws an exception if the stream is closed.
function StreamManager(stream, rawStream) {
  const self = this;
  this.rawStream = rawStream;
  this.opened = true;

  /**
   * True iff the stream is closed.
   */
  stream.__defineGetter__("closed", function stream_closed() {
    return !self.opened;
  });

  /**
   * Closes both the stream and its backing stream.  If the stream is already
   * closed, an exception is thrown.  For TextWriters, this first flushes the
   * backing stream's buffer.
   */
  stream.close = function stream_close() {
    self.ensureOpened();
    self.unload();
  };

  require("unload").ensure(this);
}

StreamManager.prototype = {
  ensureOpened: function StreamManager_ensureOpened() {
    if (!this.opened)
      throw new Error("The stream is closed and cannot be used.");
  },
  unload: function StreamManager_unload() {
    // TextWriter.writeAsync() causes rawStream to close and therefore sets
    // opened to false, so check that we're still opened.
    if (this.opened) {
      // Calling close() on both an nsIUnicharInputStream and
      // nsIBufferedOutputStream closes their backing streams.  It also forces
      // nsIOutputStreams to flush first.
      this.rawStream.close();
      this.opened = false;
    }
  }
};

function checkCharset(charset) {
  return typeof(charset) === "string" ? charset : DEFAULT_CHARSET;
}
