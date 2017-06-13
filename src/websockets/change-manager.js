/**
 * @class  layer.Websockets.ChangeManager
 * @private
 *
 * This class listens for `change` events from the websocket server,
 * and processes them.
 */
const Utils = require('../client-utils');
const logger = require('../logger');
const Message = require('../models/message');
const Conversation = require('../models/conversation');
const Channel = require('../models/channel');


class WebsocketChangeManager {
  /**
   * Create a new websocket change manager
   *
   *      var websocketChangeManager = new layer.Websockets.ChangeManager({
   *          client: client,
   *          socketManager: client.Websockets.SocketManager
   *      });
   *
   * @method
   * @param  {Object} options
   * @param {layer.Client} client
   * @param {layer.Websockets.SocketManager} socketManager
   * @returns {layer.Websockets.ChangeManager}
   */
  constructor(options) {
    this.client = options.client;
    options.socketManager.on('message', this._handleChange, this);
  }

  /**
   * Handles a Change packet from the server.
   *
   * @method _handleChange
   * @private
   * @param  {layer.LayerEvent} evt
   */
  _handleChange(evt) {
    if (evt.data.type === 'change') {
      this._processChange(evt.data.body);
    }
  }

  /**
   * Process changes from a change packet.
   *
   * Called both by _handleChange, and by the requestManager on getting a changes array.
   *
   * @method _processChanage
   * @private
   * @param {Object} msg
   */
  _processChange(msg) {
    switch (msg.operation) {
      case 'create':
        logger.info(`Websocket Change Event: Create ${msg.object.type} ${msg.object.id}`);
        logger.debug(msg.data);
        this._handleCreate(msg);
        break;
      case 'delete':
        logger.info(`Websocket Change Event: Delete ${msg.object.type} ${msg.object.id}`);
        logger.debug(msg.data);
        this._handleDelete(msg);
        break;
      case 'update':
        logger.info(`Websocket Change Event: Patch ${msg.object.type} ${msg.object.id}: ${msg.data.map(op => op.property).join(', ')}`);
        logger.debug(msg.data);
        this._handlePatch(msg);
        break;
    }
  }

  /**
   * Process a create object message from the server
   *
   * @method _handleCreate
   * @private
   * @param  {Object} msg
   */
  _handleCreate(msg) {
    msg.data.fromWebsocket = true;
    const obj = this.client._createObject(msg.data);
    if (obj) obj._loadType = 'websocket';
  }

  /**
   * Handles delete object messages from the server.
   * All objects that can be deleted from the server should
   * provide a _deleted() method to be called prior to destroy().
   *
   * @method _handleDelete
   * @private
   * @param  {Object} msg
   */
  _handleDelete(msg) {
    const entity = this.getObject(msg);
    if (entity) {
      entity._handleWebsocketDelete(msg.data);
    }
  }

  /**
   * On receiving an update/patch message from the server
   * run the LayerParser on the data.
   *
   * @method _handlePatch
   * @private
   * @param  {Object} msg
   */
  _handlePatch(msg) {
    // Can only patch a cached object
    const entity = this.getObject(msg);
    if (entity) {
      try {
        entity._inLayerParser = true;
        Utils.layerParse({
          object: entity,
          type: msg.object.type,
          operations: msg.data,
          client: this.client,
        });
        entity._inLayerParser = false;
      } catch (err) {
        logger.error('websocket-manager: Failed to handle event', msg.data);
      }
    } else {
      switch (Utils.typeFromID(msg.object.id)) {
        case 'channels':
          if (Channel._loadResourceForPatch(msg.data)) this.client.getObject(msg.object.id, true);
          break;
        case 'conversations':
          if (Conversation._loadResourceForPatch(msg.data)) this.client.getObject(msg.object.id, true);
          break;
        case 'messages':
          if (Message._loadResourceForPatch(msg.data)) this.client.getMessage(msg.object.id, true);
          break;
        case 'announcements':
          break;
      }
    }
  }

  /**
   * Get the object specified by the `object` property of the websocket packet.
   *
   * @method getObject
   * @private
   * @param  {Object} msg
   * @return {layer.Root}
   */
  getObject(msg) {
    return this.client.getObject(msg.object.id);
  }

  /**
   * Not required, but destroy is best practice
   * @method destroy
   */
  destroy() {
    this.client = null;
  }
}

/**
 * The Client that owns this.
 * @type {layer.Client}
 */
WebsocketChangeManager.prototype.client = null;

module.exports = WebsocketChangeManager;
