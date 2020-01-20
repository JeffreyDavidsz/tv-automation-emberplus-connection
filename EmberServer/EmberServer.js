const EventEmitter = require('events').EventEmitter;
const S101Server = require('../EmberSocket').S101Server;
const EmberLib = require('../EmberLib');
const JSONParser = require("./JSONParser");
const ElementHandlers = require("./ElementHandlers");
const ServerEvents = require("./ServerEvents");
const winston = require("winston");
const Errors = require("../Errors");

class TreeServer extends EventEmitter{
    /**
     * 
     * @param {string} host 
     * @param {number} port 
     * @param {TreeNode} tree 
     */
    constructor(host, port, tree) {
        super();
        this._debug = false;
        this.callback = undefined;
        this.timeoutValue = 2000;
        this.server = new S101Server(host, port);
        this.tree = tree;
        this.clients = new Set();
        this.subscribers = {};
        this._handlers = new ElementHandlers(this);

        this.server.on('listening', () => {
            winston.debug("listening");
            this.emit('listening');
            if (this.callback != null) {
                this.callback();
                this.callback = undefined;
            }
        });

        this.server.on('connection', client => {
            winston.debug("ember new connection from", client.remoteAddress());
            this.clients.add(client);
            client.on("emberTree", (root) => {
                winston.debug("ember new request from", client.remoteAddress(), root);
                // Queue the action to make sure responses are sent in order.
                client.addRequest(() => {
                    try {
                        const path = this.handleRoot(client, root);
                        this.emit("request", {client: client.remoteAddress(), root: root, path: path});
                    }
                    catch(e) {
                        winston.debug(e.stack)
                        this.emit("error", e);
                    }
                });
            });
            client.on("disconnected", () => {
                this.clients.delete(client);
                this.emit('disconnect', client.remoteAddress());
            });
            client.on("error", error => {
                this.emit('clientError', { remoteAddress: client.remoteAddress(), error });
            });
            this.emit('connection', client.remoteAddress());
        });

        this.server.on('disconnected', () => {
            this.clients.clear();
            this.emit('disconnected');
        });

        this.server.on("error", (e) => {
            this.emit("error", e);
            if (this.callback != null) {
                this.callback(e);
            }
        });
    }

    /**
     * @returns {Promise}
     */
    close() {
        return new Promise((resolve, reject) => {
            const cb = e => {
                if (e == null) {
                    return resolve();
                }
                return reject(e);
            };
            if (this.server.server != null) {
                this.server.server.close(cb);                
            }
            else {
                cb();
            }
            this.clients.clear();
        });
    }

    /**
     * 
     * @param {TreeNode} element
     * @returns {TreeNode}
     */
    getResponse(element) {
        return element.getTreeBranch(undefined, node => {
            node.update(element);
            const children = element.getChildren();
            if (children != null) {
                for (let i = 0; i < children.length; i++) {
                    node.addChild(children[i].getDuplicate());
                }
            }
        });
    }

    /**
     * 
     * @param {TreeNode} element 
     */
    getQualifiedResponse(element) {
        const res = new EmberLib.Root();
        let dup;
        if (element.isRoot() === false) {
            dup = element.toQualified();
        }
        const children = element.getChildren();
        if (children != null) {
            for (let i = 0; i < children.length; i++) {
                res.addChild(children[i].toQualified().getMinimalContent());
            }
        }
        else {
           res.addChild(dup);
        }
        return res;
    }

    /**
     * 
     * @param {S101Client} client 
     * @param {TreeNode} root 
     */
    handleError(client, node) {
        if (client != null) {
            const res = node == null ? this.tree.getMinimal() : node;
            client.sendBERNode(res);
        }
    }

    /**
     * 
     * @param {S101Socket} client 
     * @param {TreeNode} root 
     */
    handleRoot(client, root) {
        if ((root == null) || (root.elements == null) || (root.elements.size < 1)) {
            // ignore empty requests.
            return;
        }
    
        const node = root.getChildren()[0];
        client.request = node;
    
        if (node.path != null) {
            return this._handlers.handleQualifiedNode(client, node);
        }
        else if (node.isCommand()) {
            // Command on root element
            this._handlers.handleCommand(client, this.tree, node);
            return "root";
        }
        else {
            return this._handlers.handleNode(client, node);
        }
    }

    /**
     * @returns {Promise}
     */
    listen() {
        return new Promise((resolve, reject) => {
            this.callback = e => {
                this.callback = null;
                if (e == null) {
                    return resolve();
                }
                return reject(e);
            };
            this.server.listen();
        });
    }

    /**
     * 
     * @param {string} path 
     * @param {number} target 
     * @param {number[]} sources 
     */
    matrixConnect(path, target, sources) {
        doMatrixOperation(this, path, target, sources, EmberLib.MatrixOperation.connect);
    }

    /**
     * 
     * @param {string} path 
     * @param {number} target 
     * @param {number[]} sources 
     */
    matrixDisconnect(path, target, sources) {
        doMatrixOperation(this, path, target, sources, EmberLib.MatrixOperation.disconnect);
    }

    /**
     * 
     * @param {string} path 
     * @param {number} target 
     * @param {number[]} sources 
     */
    matrixSet(path, target, sources) {
        doMatrixOperation(this, path, target, sources, EmberLib.MatrixOperation.absolute);
    }

    /**
     * 
     * @param {TreeNode} element 
     */
    replaceElement(element) {
        const path = element.getPath();
        const existingElement = this.tree.getElementByPath(path);
        if (existingElement == null) {
            throw new Errors.UnknownElement(path);
        }
        const parent = existingElement._parent;
        if (parent == null) {
            throw new Errors.InvalidEmberNode(path, "No parent. Can't execute replaceElement");
        }
        // Replace the element at the parent
        parent.elements.set(existingElement.getNumber(), element);
        // point the new element to parent
        element._parent = parent;
        const res = this.getResponse(element);
        this.updateSubscribers(path,res);
    }

    /**
     * 
     * @param {TreeNode} element 
     * @param {string|number} value
     * @param {S101Socket} origin
     * @param {string} key
     */
    setValue(element, value, origin, key) {
        return new Promise(resolve => {
            // Change the element value if write access permitted.
            if (element.contents == null) {
                return resolve();
            }
            if (element.isParameter() || element.isMatrix()) {
                if (element.isParameter() &&
                    (element.contents.access != null) &&
                    (element.contents.access.value > 1)) {
                    element.contents.value = value;
                    const res = this.getResponse(element);
                    this.updateSubscribers(element.getPath(),res, origin);                    
                }
                else if ((key != null) && (element.contents.hasOwnProperty(key))) {
                    element.contents[key] = value;
                    const res = this.getResponse(element);
                    this.updateSubscribers(element.getPath(),res, origin);
                }
                const src = origin == null ? "local" : `${origin.socket.remoteAddress}:${origin.socket.remotePort}`;
                this.emit("value-change", element);
                this.emit("event", ServerEvents.SETVALUE(element.contents.identifier,element.getPath(),src));
            }
            return resolve();
        });
    }

    /**
     * 
     * @param {S101Socket} client 
     * @param {TreeNode} root 
     */
    subscribe(client, element) {
        const path = element.getPath();
        if (this.subscribers[path] == null) {
            this.subscribers[path] = new Set();
        }
        this.subscribers[path].add(client);
    }

    /**
     * @returns {Object}
     */
    toJSON() {
        if (this.tree == null) {
            return [];
        }
        const elements = this.tree.getChildren();
    
        return elements.map(element => element.toJSON());
    }

    /**
     * 
     * @param {S101Client} client 
     * @param {TreeNode} root 
     */
    unsubscribe(client, element) {
        const path = element.getPath();
        if (this.subscribers[path] == null) {
            return;
        }
        this.subscribers[path].delete(client);
    }

    /**
     * 
     * @param {string} path 
     * @param {TreeNode} response 
     * @param {S101Socket} origin 
     */
    updateSubscribers(path, response, origin) {
        if (this.subscribers[path] == null) {
            return;
        }
    
        for (let client of this.subscribers[path]) {
            if (client === origin) {
                continue; // already sent the response to origin
            }
            if (this.clients.has(client)) {
                client.queueMessage(response);
            }
            else {
                // clean up subscribers - client is gone
                this.subscribers[path].delete(client);
            }
        }
    }

    /**
     * 
     * @param {object} obj 
     * @returns {TreeNode}
     */
    static JSONtoTree(obj) {
        const tree = new EmberLib.Root();
        JSONParser.parseObj(tree, obj);
        return tree;
    }
}


const validateMatrixOperation = function(matrix, target, sources) {
    if (matrix == null) {
        throw new Errors.UnknownElement(`matrix not found`);
    }
    if (matrix.contents == null) {
        throw new Errors.MissingElementContents(matrix.getPath());
    }
    matrix.validateConnection(target, sources);
}

const doMatrixOperation = function(server, path, target, sources, operation) {
    const matrix = server.tree.getElementByPath(path);

    validateMatrixOperation(matrix, target, sources);

    const connection = new EmberLib.MatrixConnection(target);
    connection.sources = sources;
    connection.operation = operation;
    server._handlers.handleMatrixConnections(undefined, matrix, [connection], false);
}

module.exports = TreeServer;
