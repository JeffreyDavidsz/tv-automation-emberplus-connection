"use strict";

const QualifiedElement = require("./QualifiedElement");
const FunctionContent = require("./FunctionContent");
const {COMMAND_GETDIRECTORY, COMMAND_INVOKE} = require("./constants");
const BER = require('../ber.js');
const Invocation = require("./Invocation");
const errors = require("../errors");

class QualifiedFunction extends QualifiedElement {
    /**
     * 
     * @param {string} path 
     * @param {function} func 
     */
    constructor(path, func) {
        super(path);
        this.func = func;
        this._seqID = QualifiedFunction.BERID;
    }

    /**
     * 
     * @returns {TreeNode}
     */
    getDirectory() {
        return this.getCommand(COMMAND_GETDIRECTORY);
    }

    /**
     * @returns {boolean}
     */
    isFunction() {
        return true;
    }

    /**
     * 
     * @param {*} params 
     */
    invoke(params) {        
        const invocation = new Invocation(Invocation.newInvocationID());
        invocation.arguments = params;
        const qualifiedFunctionNode = this.getCommand(COMMAND_INVOKE, "invocation", invocation);
        //qualifiedFunctionNode.getElementByNumber(this.getNumber()).getElementByNumber(COMMAND_INVOKE).invocation = invocation
        return qualifiedFunctionNode;
    }
 

    /**
     * 
     * @param {BER} ber 
     * @returns {QualifiedFunction}
     */
    static decode(ber) {
        const qf = new QualifiedFunction();
        ber = ber.getSequence(QualifiedFunction.BERID);
        while(ber.remain > 0) {
            let tag = ber.peek();
            let seq = ber.getSequence(tag);
            if(tag == BER.CONTEXT(0)) {
                qf.path = seq.readRelativeOID(BER.EMBER_RELATIVE_OID); // 13 => relative OID
            }
            else if(tag == BER.CONTEXT(1)) {
                qf.contents = FunctionContent.decode(seq);
            } else if(tag == BER.CONTEXT(2)) {
                qf.decodeChildren(seq);
            }
            else {
                throw new errors.UnimplementedEmberTypeError(tag);
            }
        }
        return qf;
    }

    /**
     * @returns {number}
     */
    static get BERID() {
        return BER.APPLICATION(20);
    }
}

module.exports = QualifiedFunction;