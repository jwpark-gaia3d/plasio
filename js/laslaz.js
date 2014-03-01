// laslaz.js
// LAS/LAZ loading

(function(scope) {
	"use strict";

	var pointFormatReaders = {
		1: function(dv) {
			return {
				"position": [ dv.getInt32(0, true), dv.getInt32(4, true), dv.getInt32(8, true)],
				"intensity": dv.getUint16(12, true),
				"classification": dv.getUint8(16, true)
			};
		},
		2: function(dv) {
			return {
				"position": [ dv.getInt32(0, true), dv.getInt32(4, true), dv.getInt32(8, true)],
				"intensity": dv.getUint16(12, true),
				"classification": dv.getUint8(16, true),
				"color": [dv.getUint16(20, true), dv.getUint16(22, true), dv.getUint16(24, true)]
			};
		},
		3: function(dv) {
			return {
				"position": [ dv.getInt32(0, true), dv.getInt32(4, true), dv.getInt32(8, true)],
				"intensity": dv.getUint16(12, true),
				"classification": dv.getUint8(16, true),
				"color": [dv.getUint16(28, true), dv.getUint16(30, true), dv.getUint16(32, true)]
			};
		}
	};

	function readAs(buf, Type, offset, count) {
		count = (count === undefined || count === 0 ? 1 : count);
		var sub = buf.slice(offset, offset + Type.BYTES_PER_ELEMENT * count);

		var r = new Type(sub);
		if (count === undefined || count === 1)
			return r[0];

		var ret = []
		for (var i = 0 ; i < count ; i ++) {
			ret.push(r[i]);
		}

		return ret;
	};

	function parseLASHeader(arraybuffer) {
		var o = {};

		o.pointsOffset = readAs(arraybuffer, Uint32Array, 32*3);
		o.pointsFormatId = readAs(arraybuffer, Uint8Array, 32*3+8);
		o.pointsStructSize = readAs(arraybuffer, Uint16Array, 32*3+8+1);
		o.pointsCount = readAs(arraybuffer, Uint32Array, 32*3 + 11);


		var start = 32*3 + 35;
		o.scale = readAs(arraybuffer, Float64Array, start, 3); start += 24; // 8*3
		o.offset = readAs(arraybuffer, Float64Array, start, 3); start += 24;


		var bounds = readAs(arraybuffer, Float64Array, start, 6); start += 48; // 8*6;
		o.maxs = [bounds[0], bounds[2], bounds[4]];
		o.mins = [bounds[1], bounds[3], bounds[5]];

		return o;
	};

	var msgIndex = 0;
	var waitHandlers = {};

	// This method is scope-wide since the nacl module uses this fuction to notify
	// us of events
	scope.handleMessage = function(message_event) {
		var msg = message_event.data;
		var resolver = waitHandlers[msg.id];

		// call the callback in a separate context, make sure we've cleaned our
		// state out before the callback is invoked since it may queue more doExchanges
		setTimeout(function() { 
			if (msg.error)
				return resolver.reject(new Error(msg.message || "Unknown Error"));


			if (msg.hasOwnProperty('count') && msg.hasOwnProperty('hasMoreData')) {
				return resolver.resolve({
					buffer: msg.result,
					count: msg.count,
					hasMoreData: msg.hasMoreData});
			}

			resolver.resolve(msg.result);
		}, 0);
	};

	var doDataExchange = function(cmd, callback) {
		cmd.id = msgIndex.toString();
		msgIndex ++;

		var resolver = Promise.defer();
		waitHandlers[cmd.id] = resolver;

		nacl_module.postMessage(cmd);

		return resolver.promise;
	};

	// LAS Loader
	// Loads uncompressed files
	//
	var LASLoader = function(arraybuffer) {
		this.arraybuffer = arraybuffer;
	};

	LASLoader.prototype.open = function() {
		// nothing needs to be done to open this file
		//
		this.readOffset = 0;
		return new Promise(function(res, rej) {
			setTimeout(res, 0);
		});
	};

	LASLoader.prototype.getHeader = function() {
		var o = this;

		return new Promise(function(res, rej) {
			setTimeout(function() {
				o.header = parseLASHeader(o.arraybuffer);
				res(o.header);
			}, 0);
		});
	};

	LASLoader.prototype.readData = function(count, start, skip) {
		var o = this;

		return new Promise(function(res, rej) {
			setTimeout(function() {
				if (!o.header)
					return rej(new Error("Cannot start reading data till a header request is issued"));

				if (skip === 0) {
					count = Math.min(count, o.header.pointsCount - o.readOffset);
					var start = o.header.pointsOffset + o.readOffset * o.header.pointsStructSize;
					var end = start + count * o.header.pointsStructSize;
					console.log(start, end);
					res({
						buffer: o.arraybuffer.slice(start, end),
						count: count,
						hasMoreData: o.readOffset + count < o.header.pointsCount});
					o.readOffset += count;
				}
				else
					rej(new Error("skip != 0 implementation is not available"));
			}, 0);
		});
	};

	// LAZ Loader
	// Uses NaCL module to load LAZ files
	//
	var LAZLoader = function(arraybuffer) {
		this.arraybuffer = arraybuffer;
	};

	LAZLoader.prototype.open = function() {
		// open the file, using the laz module
		if (!LASModuleWasLoaded)
			throw new Error("LAZ Module has not been loaded, LASzip functionality is not available");

		return doDataExchange({
			command: 'open',
			target: 'myfile',
			buffer: this.arraybuffer
		});
	};

	LAZLoader.prototype.getHeader = function() {
		var o = this;

		return doDataExchange({
			command: 'getheader'
		}).then(function(header) {
			// map the module over to what we want our fields to look like
			return {
				maxs: header.maxs,
				mins: header.mins,
				offset: header.offsets,
				scale: header.scales,
				pointsCount: header.point_count,
				pointsFormatId: header.point_format_id,
				pointsStructSize: header.point_record_length,
				pointsOffset: header.data_offset
			};
		});
	};

	LAZLoader.prototype.readData = function(count, start, skip) {
		return doDataExchange({
			command: 'read',
			count: count,
			start: start,
			skip: skip
		});
	};

	// A single consistent interface for loading LAS/LAZ files
	var LASFile = function(arraybuffer) {
		this.arraybuffer = arraybuffer;

		this.determineVersion();
		if (this.version > 12)
			throw new Error("Only file versions <= 1.2 are supported at this time");

		this.determineFormat();
		this.loader = this.isCompressed ?
			new LAZLoader(this.arraybuffer) :
			new LASLoader(this.arraybuffer);
	};

	LASFile.prototype.determineFormat = function() {
		var formatId = readAs(this.arraybuffer, Uint8Array, 32*3+8);
		var bit_7 = (formatId & 0x80) >> 7;
		var bit_6 = (formatId & 0x40) >> 6;

		if (bit_7 === 1 && bit_6 === 1)
			throw new Error("Old style compression not supported");

		this.isCompressed = (bit_7 === 1 || bit_6 === 1);
	};

	LASFile.prototype.determineVersion = function() {
		var ver = new Int8Array(this.arraybuffer, 24, 2);
		this.version = ver[0] * 10 + ver[1];
		this.versionAsString = ver[0] + "." + ver[1];
	};

	LASFile.prototype.open = function() {
		return this.loader.open();
	};

	LASFile.prototype.getHeader = function() {
		return this.loader.getHeader();
	};

	LASFile.prototype.readData = function(count, start, skip) {
		return this.loader.readData(count, start, skip);
	};

	// Decodes LAS records into points
	//
	var LASDecoder = function(buffer, pointFormatID, pointSize, pointsCount, scale, offset) {
		this.arrayb = buffer;
		this.decoder = pointFormatReaders[pointFormatID];
		this.pointsCount = pointsCount;
		this.pointSize = pointSize;
		this.scale = scale;
		this.offset = offset;
	};

	LASDecoder.prototype.getPoint = function(index) {
		if (index < 0 || index >= this.pointsCount)
			throw new Error("Point index out of range");

		var dv = new DataView(this.arrayb, index * this.pointSize, this.pointSize);
		return this.decoder(dv);
	};

	// NACL Module support
	// Called by the common.js module.
	//
	window.domContentLoaded = function(name, tc, config, width, height) {
		console.log("Requesting persistent memory");

		navigator.webkitPersistentStorage.requestQuota(2048 * 2048, function(bytes) {
			common.updateStatus(
				'Allocated ' + bytes + ' bytes of persistant storage.');
				common.attachDefaultListeners();
				common.createNaClModule(name, tc, config, width, height);
		},
		function(e) { alert('Failed to allocate space') });
	};

	window.moduleDidLoad = function() {
		common.hideModule();
		LASModuleWasLoaded = true;
	}


	scope.LASFile = LASFile;
	scope.LASDecoder = LASDecoder;
	scope.LASModuleWasLoaded = false;
})(window);

