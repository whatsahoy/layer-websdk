/**
 * The MessagePart class represents an element of a message.
 *
 *      // Create a Message Part with any mimeType
 *      var part = new layer.MessagePart({
 *          body: "hello",
 *          mimeType: "text/plain"
 *      });
 *
 *      // Create a text/plain only Message Part
 *      var part = new layer.MessagePart("Hello I am text/plain");
 *
 * You can also create a Message Part from a File Input dom node:
 *
 *      var fileInputNode = document.getElementById("myFileInput");
 *      var part = new layer.MessagePart(fileInputNode.files[0]);
 *
 * You can also create Message Parts from a file drag and drop operation:
 *
 *      onFileDrop: function(evt) {
 *           var files = evt.dataTransfer.files;
 *           var m = conversation.createMessage({
 *               parts: files.map(function(file) {
 *                  return new layer.MessagePart({body: file, mimeType: file.type});
 *               }
 *           });
 *      });
 *
 * ### Blobs vs Strings
 *
 * You should always expect to see the `body` property be a Blob **unless** the mimeType is listed in layer.MessagePart.TextualMimeTypes,
 * in which case the value will be a String.  You can add mimeTypes to TextualMimeTypes:
 *
 * ```
 * layer.MessagePart.TextualMimeTypes = ['text/plain', 'text/mountain', /^application\/json(\+.+)$/]
 * ```
 *
 * Any mimeType matching the above strings and regular expressions will be transformed to text before being delivered to your app; otherwise it
 * must be a Blob.  Note that the above snippet sets a static property that is set once, and affects all MessagePart objects for the lifespan of
 * the app.
 *
 * ### Accesing Rich Content
 *
 * There are two ways of accessing rich content
 *
 * 1. Access the data directly: `part.fetchContent(function(data) {myRenderData(data);})`. This approach downloads the data,
 *    writes it to the the `body` property, writes a Data URI to the part's `url` property, and then calls your callback.
 *    By downloading the data and storing it in `body`, the data does not expire.
 * 2. Access the URL rather than the data.  When you first receive the Message Part it will have a valid `url` property; however, this URL expires.  *    URLs are needed for streaming, and for content that doesn't yet need to be rendered (e.g. hyperlinks to data that will render when clicked).
 *    The url property will return a string if the url is valid, or '' if its expired.  Call `part.fetchStream(callback)` to get an updated URL.
 *    The following pattern is recommended:
 *
 * ```
 * if (!part.url) {
 *   part.fetchStream(function(url) {myRenderUrl(url)});
 * } else {
 *   myRenderUrl(part.url);
 * }
 * ```
 *
 * NOTE: `layer.MessagePart.url` should have a value when the message is first received, and will only fail `if (!part.url)` once the url has expired.
 *
 * @class  layer.MessagePart
 * @extends layer.Root
 * @author Michael Kantor
 */

const Root = require('../root');
const Content = require('./content');
const xhr = require('../xhr');
const ClientRegistry = require('../client-registry');
const LayerError = require('../layer-error');
const Util = require('../client-utils');
const logger = require('../logger');

class MessagePart extends Root {

  /**
   * Constructor
   *
   * @method constructor
   * @param  {Object} options - Can be an object with body and mimeType, or it can be a string, or a Blob/File
   * @param  {string} options.body - Any string larger than 2kb will be sent as Rich Content, meaning it will be uploaded to cloud storage and must be separately downloaded from the Message when its received.
   * @param  {string} [options.mimeType=text/plain] - Mime type; can be anything; if your client doesn't have a renderer for it, it will be ignored.
   * @param  {number} [options.size=0] - Size of your part. Will be calculated for you if not provided.
   *
   * @return {layer.MessagePart}
   */
  constructor(options, ...args) {
    let newOptions = options;
    if (typeof options === 'string') {
      newOptions = { body: options };
      if (args.length > 0) {
        newOptions.mimeType = args[0];
      } else {
        newOptions.mimeType = 'text/plain';
      }
    } else if (Util.isBlob(options) || Util.isBlob(options.body)) {
      const body = options instanceof Blob ? options : options.body;
      const mimeType = Util.isBlob(options.body) ? options.mimeType : body.type;
      newOptions = {
        mimeType,
        body,
        size: body.size,
        hasContent: true,
      };
    }
    super(newOptions);

    this.mimeAttributes = {};
    this._moveMimeTypeToAttributes();

    if (!this.size && this.body) this.size = this.body.length;

    // Don't expose encoding; blobify it if its encoded.
    if (options.encoding === 'base64') {
      this.body = Util.base64ToBlob(this.body);
    }

    // Could be a blob because it was read out of indexedDB,
    // or because it was created locally with a file
    // Or because of base64 encoded data.
    const isBlobBody = Util.isBlob(this.body);
    const textual = this.isTextualMimeType();

    // Custom handling for non-textual content
    if (!textual) {
      // If the body exists and is a blob, extract the data uri for convenience; only really relevant for image and video HTML tags.
      if (!isBlobBody && this.body) this.body = new Blob([this.body], { type: this.mimeType });
      if (this.body) this.url = URL.createObjectURL(this.body);
    }

    // If our textual content is a blob, turning it into text is asychronous, and can't be done in the synchronous constructor
    // This will only happen when the client is attaching a file.  Conversion for locally created messages is done while calling `Message.send()`
  }


  _moveMimeTypeToAttributes() {
    const attributes = this.mimeAttributes;
    const parameters = this.mimeType.split(/\s*;\s*/);
    if (!parameters) return;
    this.mimeType = parameters.shift();

    parameters.forEach((param) => {
      const index = param.indexOf('=');
      if (index === -1) {
        attributes[param] = true;
      } else {
        const pName = param.substring(0, index);
        const pValue = param.substring(index + 1);
        attributes[pName] = pValue;
      }
    });
  }

  destroy() {
    if (this.__url) {
      URL.revokeObjectURL(this.__url);
      this.__url = null;
    }
    this.body = null;
    super.destroy();
  }

  /**
   * Get the layer.Client associated with this layer.MessagePart.
   *
   * Uses the layer.MessagePart.clientId property.
   *
   * @method _getClient
   * @private
   * @return {layer.Client}
   */
  _getClient() {
    return ClientRegistry.get(this.clientId);
  }

  /**
   * Get the layer.Message associated with this layer.MessagePart.
   *
   * @method _getMessage
   * @private
   * @return {layer.Message}
   */
  _getMessage() {
    return this._getClient().getMessage(this.id.replace(/\/parts.*$/, ''));
  }

  /**
   * Download Rich Content from cloud server.
   *
   * For MessageParts with rich content, this method will load the data from google's cloud storage.
   * The body property of this MessagePart is set to the result.
   *
   *      messagepart.fetchContent()
   *      .on("content-loaded", function() {
   *          render(messagepart.body);
   *      });
   *
   * Note that a successful call to `fetchContent` will also cause Query change events to fire.
   * In this example, `render` will be called by the query change event that will occur once the content has downloaded:
   *
   * ```
   *  query.on('change', function(evt) {
   *    render(query.data);
   *  });
   *  messagepart.fetchContent();
   * ```
   *
   *
   * @method fetchContent
   * @param {Function} [callback]
   * @param {Mixed} callback.data - Either a string (mimeType=text/plain) or a Blob (all other mimeTypes)
   * @return {layer.Content} this
   */
  fetchContent(callback) {
    if (this._content && !this.isFiring) {
      this.isFiring = true;
      const type = this.mimeType === 'image/jpeg+preview' ? 'image/jpeg' : this.mimeType;
      this._content.loadContent(type, (err, result) => {
        if (!this.isDestroyed) this._fetchContentCallback(err, result, callback);
      });
    }
    return this;
  }


  /**
   * Callback with result or error from calling fetchContent.
   *
   * @private
   * @method _fetchContentCallback
   * @param {layer.LayerError} err
   * @param {Object} result
   * @param {Function} callback
   */
  _fetchContentCallback(err, result, callback) {
    if (err) {
      this.trigger('content-loaded-error', err);
    } else {
      this.isFiring = false;
      if (this.isTextualMimeType()) {
        Util.fetchTextFromFile(result, text => this._fetchContentComplete(text, callback));
      } else {
        this.url = URL.createObjectURL(result);
        this._fetchContentComplete(result, callback);
      }
    }
  }

  /**
   * Callback with Part Body from _fetchContentCallback.
   *
   * @private
   * @method _fetchContentComplete
   * @param {Blob|String} body
   * @param {Function} callback
   */
  _fetchContentComplete(body, callback) {
    const message = this._getMessage();
    if (!message) return;

    // NOTE: This will trigger a messageparts:change event, and therefore a messages:change event
    this.body = body;

    this.trigger('content-loaded');

    // TODO: This event is now deprecated, and should be removed for WebSDK 4.0
    message._triggerAsync('messages:change', {
      oldValue: message.parts,
      newValue: message.parts,
      property: 'parts',
    });

    if (callback) callback(this.body);
  }


  /**
   * Access the URL to the remote resource.
   *
   * Useful for streaming the content so that you don't have to download the entire file before rendering it.
   * Also useful for content that will be openned in a new window, and does not need to be fetched now.
   *
   * For MessageParts with Rich Content, will lookup a URL to your Rich Content.
   * Useful for streaming and content so that you don't have to download the entire file before rendering it.
   *
   * ```
   * messagepart.fetchStream(function(url) {
   *     render(url);
   * });
   * ```
   *
   * Note that a successful call to `fetchStream` will also cause Query change events to fire.
   * In this example, `render` will be called by the query change event that will occur once the `url` has been refreshed:
   *
   * ```
   *  query.on('change', function(evt) {
   *      render(query.data);
   *  });
   *  messagepart.fetchStream();
   * ```
   *
   * @method fetchStream
   * @param {Function} [callback]
   * @param {Mixed} callback.url
   * @return {layer.Content} this
   */
  fetchStream(callback) {
    if (!this._content) throw new Error(LayerError.dictionary.contentRequired);
    if (this._content.isExpired()) {
      this._content.refreshContent(this._getClient(), url => this._fetchStreamComplete(url, callback));
    } else {
      this._fetchStreamComplete(this._content.downloadUrl, callback);
    }
    return this;
  }

  // Does not set this.url; instead relies on fact that this._content.downloadUrl has been updated
  _fetchStreamComplete(url, callback) {
    const message = this._getMessage();

    this.trigger('url-loaded');

    this._triggerAsync('messageparts:change', {
      oldValue: '',
      newValue: url,
      property: 'url',
    });

    // TODO: This event is now deprecated, and should be removed for WebSDK 4.0
    message._triggerAsync('messages:change', {
      oldValue: message.parts,
      newValue: message.parts,
      property: 'parts',
    });
    if (callback) callback(url);
  }

  /**
   * Preps a MessagePart for sending.  Normally that is trivial.
   * But if there is rich content, then the content must be uploaded
   * and then we can trigger a "parts:send" event indicating that
   * the part is ready to send.
   *
   * @method _send
   * @protected
   * @param  {layer.Client} client
   * @fires parts:send
   */
  _send(client) {
    // There is already a Content object, presumably the developer
    // already took care of this step for us.
    if (this._content) {
      this._sendWithContent();
    }

    // If the size is large, Create and upload the Content
    else if (this.size > 2048) {
      this._generateContentAndSend(client);
    }

    // If the body is a blob, but is not YET Rich Content, do some custom analysis/processing:
    else if (Util.isBlob(this.body)) {
      this._sendBlob(client);
    }

    // Else the message part can be sent as is.
    else {
      this._sendBody();
    }
  }

  getMimeTypeWithAttributes() {
    const attributeString = Object.keys(this.mimeAttributes).map((key) => {
      if (this.mimeAttributes[key] === true) return key;
      return key + '=' + this.mimeAttributes[key];
    }).join(';');
    return this.mimeType + (attributeString ? ';' + attributeString : '');
  }

  _sendBody() {
    if (typeof this.body !== 'string') {
      const err = 'MessagePart.body must be a string in order to send it';
      logger.error(err, { mimeType: this.mimeType, body: this.body });
      throw new Error(err);
    }

    const obj = {
      mime_type: this.getMimeTypeWithAttributes(),
      body: this.body,
    };
    this.trigger('parts:send', obj);
  }

  _sendWithContent() {
    this.trigger('parts:send', {
      mime_type: this.getMimeTypeWithAttributes(),
      content: {
        size: this.size,
        id: this._content.id,
      },
    });
  }

  /**
   * This method is only called if Blob.size < 2048.
   *
   * However, conversion to base64 can impact the size, so we must retest the size
   * after conversion, and then decide to send the original blob or the base64 encoded data.
   *
   * @method _sendBlob
   * @private
   * @param {layer.Client} client
   */
  _sendBlob(client) {
    /* istanbul ignore else */
    Util.blobToBase64(this.body, (base64data) => {
      if (base64data.length < 2048) {
        const body = base64data.substring(base64data.indexOf(',') + 1);
        const obj = {
          body,
          mime_type: this.getMimeTypeWithAttributes(),
        };
        obj.encoding = 'base64';
        this.trigger('parts:send', obj);
      } else {
        this._generateContentAndSend(client);
      }
    });
  }

  /**
   * Create an rich Content object on the server
   * and then call _processContentResponse
   *
   * @method _generateContentAndSend
   * @private
   * @param  {layer.Client} client
   */
  _generateContentAndSend(client) {
    this.hasContent = true;
    let body;
    if (!Util.isBlob(this.body)) {
      body = Util.base64ToBlob(Util.utoa(this.body), this.mimeType);
    } else {
      body = this.body;
    }
    client.xhr({
      url: '/content',
      method: 'POST',
      headers: {
        'Upload-Content-Type': this.mimeType,
        'Upload-Content-Length': body.size,
        'Upload-Origin': typeof location !== 'undefined' ? location.origin : '',
      },
      sync: {},
    }, result => this._processContentResponse(result.data, body, client));
  }

  /**
   * Creates a layer.Content object from the server's
   * Content object, and then uploads the data to google cloud storage.
   *
   * @method _processContentResponse
   * @private
   * @param  {Object} response
   * @param  {Blob} body
   * @param  {layer.Client} client
   * @param {Number} [retryCount=0]
   */
  _processContentResponse(response, body, client, retryCount = 0) {
    this._content = new Content(response.id);
    this.hasContent = true;
    xhr({
      url: response.upload_url,
      method: 'PUT',
      data: body,
      headers: {
        'Upload-Content-Length': this.size,
        'Upload-Content-Type': this.mimeType,
      },
    }, result => this._processContentUploadResponse(result, response, client, body, retryCount));
  }

  /**
   * Process the response to uploading the content to google cloud storage.
   *
   * Result is either:
   *
   * 1. trigger `parts:send` on success
   * 2. call `_processContentResponse` to retry
   * 3. trigger `messages:sent-error` if retries have failed
   *
   * @method _processContentUploadResponse
   * @private
   * @param  {Object} uploadResult    Response from google cloud server; note that the xhr method assumes some layer-like behaviors and may replace non-json responses with js objects.
   * @param  {Object} contentResponse Response to `POST /content` from before
   * @param  {layer.Client} client
   * @param  {Blob} body
   * @param  {Number} retryCount
   */
  _processContentUploadResponse(uploadResult, contentResponse, client, body, retryCount) {
    if (!uploadResult.success) {
      if (!client.onlineManager.isOnline) {
        client.onlineManager.once('connected', this._processContentResponse.bind(this, contentResponse, client), this);
      } else if (retryCount < MessagePart.MaxRichContentRetryCount) {
        this._processContentResponse(contentResponse, body, client, retryCount + 1);
      } else {
        logger.error('Failed to upload rich content; triggering message:sent-error event; status of ', uploadResult.status, this);
        this._getMessage().trigger('messages:sent-error', {
          error: new LayerError({
            message: 'Upload of rich content failed',
            httpStatus: uploadResult.status,
            code: 0,
            data: uploadResult.xhr,
          }),
          part: this,
        });
      }
    } else {
      this.trigger('parts:send', {
        mime_type: this.getMimeTypeWithAttributes(),
        content: {
          size: this.size,
          id: this._content.id,
        },
      });
    }
  }

  /**
   * Returns the text for any text/plain part.
   *
   * Returns '' if its not a text/plain part.
   *
   * @method getText
   * @return {string}
   */
  getText() {
    if (this.isTextualMimeType()) {
      return this.body;
    } else {
      return '';
    }
  }

  /**
   * Updates the MessagePart with new data from the server.
   *
   * Currently, MessagePart properties do not update... however,
   * the layer.Content object that Rich Content MessageParts contain
   * do get updated with refreshed expiring urls.
   *
   * @method _populateFromServer
   * @param  {Object} part - Server representation of a part
   * @private
   */
  _populateFromServer(part) {
    if (part.content && this._content) {
      this._content.downloadUrl = part.content.download_url;
      this._content.expiration = new Date(part.content.expiration);
    }
  }

  /**
   * Is the mimeType for this MessagePart defined as textual content?
   *
   * If the answer is true, expect a `body` of string, else expect `body` of Blob.
   *
   * To change whether a given MIME Type is treated as textual, see layer.MessagePart.TextualMimeTypes.
   *
   * @method isTextualMimeType
   * @returns {Boolean}
   */
  isTextualMimeType() {
    let i = 0;
    for (i = 0; i < MessagePart.TextualMimeTypes.length; i++) {
      const test = MessagePart.TextualMimeTypes[i];
      if (typeof test === 'string') {
        if (test === this.mimeType) return true;
      } else if (test instanceof RegExp) {
        if (this.mimeType.match(test)) return true;
      }
    }
    return false;
  }

  /**
   * This method is automatically called any time the body is changed.
   *
   * Note that it is not called during initialization.  Any developer who does:
   *
   * ```
   * part.body = "Hi";
   * ```
   *
   * can expect this to trigger a change event, which will in turn trigger a `messages:change` event on the layer.Message.
   *
   * @method __updateBody
   * @private
   * @param {String} newValue
   * @param {String} oldValue
   */
  __updateBody(newValue, oldValue) {
    this._triggerAsync('messageparts:change', {
      property: 'body',
      newValue,
      oldValue,
    });
  }

  /**
   * This method is automatically called any time the mimeType is changed.
   *
   * Note that it is not called during initialization.  Any developer who does:
   *
   * ```
   * part.mimeType = "text/mountain";
   * ```
   *
   * can expect this to trigger a change event, which will in turn trigger a `messages:change` event on the layer.Message.
   *
   * @method __updateMimeType
   * @private
   * @param {String} newValue
   * @param {String} oldValue
   */
  __updateMimeType(newValue, oldValue) {
    if (newValue.match(/;/)) {
      this.mimeAttributes = {};
      this._moveMimeTypeToAttributes();
    }
    this._triggerAsync('messageparts:change', {
      property: 'mimeType',
      newValue,
      oldValue,
    });
  }

  /**
   * Creates a MessagePart from a server representation of the part
   *
   * @method _createFromServer
   * @private
   * @static
   * @param  {Object} part - Server representation of a part
   */
  static _createFromServer(part) {
    const content = (part.content) ? Content._createFromServer(part.content) : null;

    // Turn base64 data into a Blob
    if (part.encoding === 'base64') part.body = Util.base64ToBlob(part.body, part.mimeType);

    // Create the MessagePart
    return new MessagePart({
      id: part.id,
      mimeType: part.mime_type,
      body: part.body || '',
      _content: content,
      hasContent: Boolean(content),
      size: part.size || 0,
    });
  }
}

/**
 * layer.Client that the conversation belongs to.
 *
 * Actual value of this string matches the appId.
 * @type {string}
 */
MessagePart.prototype.clientId = '';

/**
 * Server generated identifier for the part
 * @type {string}
 */
MessagePart.prototype.id = '';

/**
 * Body of your message part.
 *
 * This is the core data of your part.
 *
 * If this is `null` then most likely layer.Message.hasContent is true, and you
 * can either use the layer.MessagePart.url property or the layer.MessagePart.fetchContent method.
 *
 * @type {string}
 */
MessagePart.prototype.body = null;

/**
 * Rich content object.
 *
 * This will be automatically created for you if your layer.MessagePart.body
 * is large.
 * @type {layer.Content}
 * @private
 */
MessagePart.prototype._content = null;

/**
 * The Part has rich content
 * @type {Boolean}
 */
MessagePart.prototype.hasContent = false;

/**
 * URL to rich content object.
 *
 * Parts with rich content will be initialized with this property set.  But its value will expire.
 *
 * Will contain an expiring url at initialization time and be refreshed with calls to `layer.MessagePart.fetchStream()`.
 * Will contain a non-expiring url to a local resource if `layer.MessagePart.fetchContent()` is called.
 *
 * @type {layer.Content}
 */
Object.defineProperty(MessagePart.prototype, 'url', {
  enumerable: true,
  get: function get() {
    // Its possible to have a url and no content if it has been instantiated but not yet sent.
    // If there is a __url then its a local url generated from the body property and does not expire.
    if (this.__url) return this.__url;
    if (this._content) return this._content.isExpired() ? '' : this._content.downloadUrl;
    return '';
  },
  set: function set(inValue) {
    this.__url = inValue;
  },
});

/**
 * Mime Type for the data represented by the MessagePart.
 *
 * Typically this is the type for the data in layer.MessagePart.body;
 * if there is Rich Content, then its the type of Content that needs to be
 * downloaded.
 *
 * @type {String}
 */
MessagePart.prototype.mimeType = 'text/plain';

/**
 * Mime Type Attributes are attributes provided via the mimeType.
 *
 * These attributes are removed from the mimeType and moved into a hash.
 *
 * @type {Object}
 */
MessagePart.prototype.mimeAttributes = null;

/**
 * Size of the layer.MessagePart.body.
 *
 * Will be set for you if not provided.
 * Only needed for use with rich content.
 *
 * @type {number}
 */
MessagePart.prototype.size = 0;

/**
 * Array of mime types that should be treated as text.
 *
 * Treating a MessagePart as text means that even if the `body` gets a File or Blob,
 * it will be transformed to a string before being delivered to your app.
 *
 * This value can be customized using strings and regular expressions:
 *
 * ```
 * layer.MessagePart.TextualMimeTypes = ['text/plain', 'text/mountain', /^application\/json(\+.+)$/]
 * ```
 *
 * @static
 * @type {Mixed[]}
 */
MessagePart.TextualMimeTypes = [/^text\/.+$/, /^application\/json(\+.+)?$/];

/**
 * Number of retry attempts to make before giving up on uploading Rich Content to Google Cloud Storage.
 *
 * @type {Number}
 */
MessagePart.MaxRichContentRetryCount = 3;

MessagePart._supportedEvents = [
  'parts:send',
  'content-loaded',
  'url-loaded',
  'content-loaded-error',
  'messageparts:change',
].concat(Root._supportedEvents);
Root.initClass.apply(MessagePart, [MessagePart, 'MessagePart']);

module.exports = MessagePart;
