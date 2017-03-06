const buble = require('rollup-plugin-buble'),
	node_resolve = require('rollup-plugin-node-resolve'),
	commonjs = require('rollup-plugin-commonjs');

export default {
	"entry": "living-room.es6.js",
	"dest": "living-room.js",
	"format": "iife",
	"plugins": [
		buble(),
		node_resolve({jsnext: true, main: true}),
		commonjs({sourceMap: false})
	]
};
