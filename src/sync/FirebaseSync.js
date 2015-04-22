/*
 * FirebaseSync synchronizes objects between multiple clients using Firebase DB.
 * Automatically creates a new room, if room not specified in URL query string.
 * Syncs object position, rotation, and scale (must be THREE.Object3D instance).
 * Optionally syncs object.userData properties given in syncUserDataProps param. 
 *
 * Author: Amber Roy
 * Copyright (c) 2015 AltspaceVR
 */



FirebaseSync = function(firebaseRootUrl, appId, params) {

	console.log("Using firebase " + firebaseRootUrl);

	this.firebaseRootUrl = firebaseRootUrl;
	this.firebaseRoot = new Firebase(firebaseRootUrl);
	this.appId = appId;

	this.onConnectComplete;

	var p = params || {};

	// console.log firebase events for debugging
	this.TRACE = !!p.TRACE;

	this.objects = [];	// in the order they were added
	this.key2obj = {};	// key2obj[ key ] = object
	this.uuid2key = {};	// uuid2key[ object.uuid ] = key
	this.objectsInitialized = [];

	this.lastObjectData = {}; // uuid to last objectData synced

	// TODO: Use unique ids instead of random. 
	this.senderId = "user" + Math.round(Math.random() * 1000);

	this.roomId;
	this.roomKey;
	this.roomURL;
	this.firebaseRoom;

	this.latencySamples = [];
	this.isLatencySaved = false;
	this.reloadWithNewURL = false;
	this.roomCreated = false;


	// type check
	if ( p.syncUserDataProps && ! (p.syncUserDataProps instanceof Array)) {
		var errMsg = "Expected array for syncUserDataProps";
		console.log(errMsg);
		throw new Error(errMsg);
	}
};


FirebaseSync.prototype.addObject = function( object, key ) {

	if (! object ) {
		console.error("Object cannot be null.");
		return ; // sanity check 
	}
	if (! key ) {
		console.error("Key cannot be null.");
		return ; // sanity check 
	}
	if ( typeof key !== "string" ) {
		console.error("Key must be a string.");
		return ; // sanity check 
	}
	if ( this.key2obj[ key ] ) {
		console.error("Object already added", object);
		return ; // Can't think of a reason to re-add the same object.
	}

	// false until we get the first update callback for this object
	object.userData.isSyncInitialized = false;

	this.objects.push( object );
	this.key2obj[ key ] = object;
	this.uuid2key[ object.uuid ] = key;

}


FirebaseSync.prototype.connect = function( onCompleteCallback ) {

	this.onConnectComplete = onCompleteCallback;

	// Handle these cases:
	// (1) No roomId specified in URL: create room with random roomId and join it.
	// (2) RoomId specified in URL, and room exists in DB: join it.
	// (3) RoomId specified in URL, but room does not exists: create and join it. 

	if ( this.objects.length === 0) {
		console.error("Must FirebaseSync.add() objects before calling connect.");
		// We can subscribe to all objects in the room, instead of specific object keys,
		// but then cannot handle a position update for an object we don't have locally.
		// Basically all clients need to know up front which objects are being synced.
		// TODO: Allow creating objects added by other clients during the game.
		return ;
	}

	// URI parsing from https://gist.github.com/jlong/2428561
	// TODO: use better query parsing, maybe use jQuery.
	var parser = document.createElement('a');
	parser.href = document.URL;

	var tokens = parser.search.substring(1).split('&');
	for ( var i=0; i < tokens.length; i++ ) {

		// Search for 'room=something' in the URL for this page.
		var kvp = tokens[i];
		if (kvp.match(/room=/)) {
			this.roomId = kvp.split('=')[1];
			break ; // use the first roomId we find (should only be one)
		}

	}

	// Three exit conditions for this method.

	if (!this.roomId) {

		// If query string didn't specify a valid roomId, create new room. 
		console.log("No roomId specified in URL, generating one randomly.");
		var randId = Math.round(Math.random() * 1000);
		this.roomId = "room" + randId;
		this.roomURL = document.URL + "?room=" + this.roomId;

		this.reloadWithNewURL = true;
		this.roomKey = this._createFirebaseRoom();

		return ; // (1) No roomId in URL, wait to reload the page with new room URL

	} 

	this.roomKey = null;
	this.getRoomKey();
	console.log("Waiting to get room key from server...")

	// Wait unitl we get the room key from the server before proceeding.
	var interval1 = setInterval( function() {

		if ( this.roomKey ) {

			clearInterval( interval1 );

			if (this.roomKey !== -1) {
				this._startListeningRoom();
				return ;	// (2) Existing Room Id given in URL, no need to create room.
			}

			// (3) Room Id specified in URL, but room doesn't exist, need to create it.
			this.roomCreated = false;
			this.roomKey = this._createFirebaseRoom();
			console.log("Waiting to create room on server...")

			var interval2 = setInterval( function() {

				if ( this.roomCreated ) {

					clearInterval( interval2 );
					this._startListeningRoom();

				}

			}.bind( this ), 500 );
		}
	}.bind( this ), 500 );

};


FirebaseSync.prototype.getRoomKey = function() {

	// Throw exception if connecting to Firebase fails, to avoid hanging.
	var errMsg = "Room id " + this.roomId + " not valid, expected format: room123 (< 1000)";

	var split = this.roomId.split("room");
	if (!split || split.length !== 2) {

		throw new Error(errMsg);

	}
	var roomNum = Number(split[1]);

	if (isNaN(roomNum) || roomNum < 0 || roomNum >= 1000) {

		// TODO: Better validation on roomId
		throw new Error(errMsg);

	}

	// Find the roomKey for this roomId.
	var roomsRef = this.firebaseRoot.child(this.appId).child("rooms");
	var path = this.firebaseRoot.toString() + "/" + this.appId + "/rooms";
	if (!roomsRef) {

		var errMsg = "Failed to get rooms at " + path;
		throw new Error(errMsg);

	}

	var queryRef = roomsRef.orderByChild("roomId").equalTo(this.roomId);

	queryRef.once("value", function(querySnapshot) {

		if (!querySnapshot.exists()) {

			console.log("No room at " + path + "/" + this.roomId + ", creating it.");
			this.roomKey = -1;	// indicates that this room doesn't exist

		} else {

			// TODO: Warn user if multiple rooms with same roomId.
			this.roomKey = Object.keys(querySnapshot.val())[0];
			this.roomURL = document.URL;
			console.log("Got roomId from page URL " + document.URL);

		}

	}.bind ( this ), this._firebaseError );

};


FirebaseSync.prototype._startListeningRoom = function() {

	if ( !this.roomKey || this.roomKey === -1 ) {
		throw new Error("Cannot subscribe to firebase, no roomKey for room", this.roomId);
	}

	// roomKey gets us into the right room.	=:-)
	this.firebaseRoom = this.firebaseRoot.child(this.appId).child("rooms").child(this.roomKey);
	if (this.firebaseRoom) {

		// TODO: return this link to caller
		console.log("Subscribing to " + this.roomId + " at " + this.firebaseRoom.toString());

	} else {

		var path = this.firebaseRoot.toString() + "/rooms" + "/" + this.roomKey;
		throw new Error("Failed to find room", path);

	}

	// Add ourself as a member in this room.
	var memberData = {
		userId: this.senderId,
		joinedAt: Firebase.ServerValue.TIMESTAMP,
	};
	this.firebaseRoom.child("members").push( memberData, this._firebaseComplete );

	// Listen for changes to all objects added so far.
	for ( var i=0; i < this.objects.length; i++ ) {

		var object = this.objects[i];
		var key = this.uuid2key[ object.uuid ];
		if (! key ) {
			console.error("Key not found for object", object);
			return ; // Shouldn't happen, we remember keys for all added objects.
		}
		this.firebaseRoom.child("objects").child(key).on("value",

			function(snapshot) {
				this._onPositionChange(snapshot);

		}.bind( this ), this._firebaseCancel);

	}

	if ( this.onConnectComplete ) {

		var roomInfo = {

			thisUrl: this.roomURL,
			appId: this.appId,
			roomId: this.roomId,
			senderId: this.senderId,
			firebaseRoomKey: this.roomKey,
			firebaseRootUrl: this.firebaseRoot.toString(),
			firebaseRoomUrl: this.firebaseRoom.toString(),

		};

		this.onConnectComplete( roomInfo );
	}

};


FirebaseSync.prototype._saveLatencyStats = function() {


	var sum = 0, i = this.latencySamples.length; 
	while(i--) sum += this.latencySamples[i];
	var average = Math.round(sum / this.latencySamples.length);
	var latencyData = {

		recieverId: this.senderId,
		roomId: this.roomId,
		savedAt: Date.now(),
		samples: this.latencySamples,
		average: average
	}
	var firebaseLatency = this.firebaseRoot.child(this.appId).child("stats/latency");
	firebaseLatency.push(latencyData, this._firebaseComplete);

	console.log("Firebase latency samples : " + this.latencySamples + " ms");
	console.log("Firebase latency average: " + average + " ms");

};

FirebaseSync.prototype._createFirebaseRoom = function() {

	var randId = Math.round(Math.random() * 1000);

	var roomData = {
		roomName: "Room " + randId, 
		roomId: this.roomId,
		createdAt: Firebase.ServerValue.TIMESTAMP,
		updatedAt: Firebase.ServerValue.TIMESTAMP,
		members: null,
		objects: null
	};
	var newRoomRef = this.firebaseRoot.child(this.appId).child("rooms").push(roomData, 
		function(ErrorObject) {
			if (ErrorObject) {
				this._firebaseError(ErrorObject); 
			} else {
				console.log("Created " + this.roomId + " at " + newRoomRef.toString());

				if (this.reloadWithNewURL) {

					// Add the query string for this room to the current URL and reload.
					console.log("Reloading page with roomId in URL");
					window.location.search = "room=" + this.roomId;
					// we never get here, reloads page with this roomId in URL

				}

				this.roomCreated = true;

			}
	}.bind( this ));

	// This is the roomKey, let caller handle it so we only set roomKey in one place.
	return newRoomRef.key();

};


FirebaseSync.prototype._onPositionChange = function(snapshot) {

	var key = snapshot.key();
	var object = this.key2obj[key];
	if ( !object ) {
		// TODO: Support creating objects added by other players.
		console.error("No object for key", key);
		return ; 
	}

	if (! snapshot.exists() ) {
		// First game ever (or we cleared the database).
		this.saveObject( object );

		// above set will trigger this callback again
		return;

	}

	var objectData = snapshot.val();

	this.lastObjectData[ object.uuid ] = objectData;

	var objectInitialized = this.objectsInitialized.indexOf( object ) !== -1;
	if ( objectData.senderId !== this.senderId || !objectInitialized ) {

		// Another player moved the object!
		this._copyObjectData( object, objectData );

		if ( this.TRACE ) console.log("RECV update for " + key, objectData);

		if ( objectData !== this.senderId && objectInitialized ) {

			this._collectLatencyStats(snapshot.val());

		}

		if ( ! objectInitialized ) {

			this.objectsInitialized.push( object );

			// this local object now synchronized
			object.userData.isSyncInitialized = true;

			if ( this.TRACE ) console.log("INIT for " + key, objectData);
		}

	}

};


FirebaseSync.prototype._collectLatencyStats = function(snapshotValue) {

	var sentAt = snapshotValue.sentAt;
	if (this.latencySamples.length < 4) {

		var now = Date.now();
		var latency = now - snapshotValue.sentAt;				
		this.latencySamples.push(latency);

	} else {

		if (this.latencySamples.length === 4 && !this.isLatencySaved ) {

			this.isLatencySaved = true;
			this._saveLatencyStats();

		}
	}

};

FirebaseSync.prototype.saveObject = function(object) {

	if ( !this.firebaseRoom ) return ; // still initializing

	var objectKey = this.uuid2key[ object.uuid ];
	if ( !objectKey ) {
		console.error("Object not yet added to FirebaseSync", object);
		return ; // Cannot save positon if we don't have object's key.
	}

	var objectData = this._createObjectData( object );
	this.firebaseRoom.child("objects").child(objectKey).set(
		objectData, this._firebaseComplete
	);
	this.firebaseRoom.child("updatedAt").set(
		Firebase.ServerValue.TIMESTAMP, this._firebaseComplete
	);
	if ( this.TRACE ) console.log("SENT update for " + object, objectData);

};


FirebaseSync.prototype.save = function() {
	// Save ALL objects, if they have changed since the last time we synced.
	// NOT recommended to call this in your update loop if objects change
	// every frame, such as a continuously rotation or random movement.

	for (var i=0; i < this.objects.length; i++) {

		var object = this.objects[i];
		var lastData = this.lastObjectData[ object.uuid ];
		if ( !lastData || !this._sameObjectData( object, lastData)) {

			this.saveObject( object );

		}
	}

}

FirebaseSync.prototype._createObjectData = function( object ) {

	var objectData = {

		// flatten THREE.Vector3 objects into x, y, z

		"position": {
			x: object.position.x,
			y: object.position.y,
			z: object.position.z
		},
		"rotation": {
			x: object.rotation.x,
			y: object.rotation.y,
			z: object.rotation.z
		},
		"scale" : {
			x: object.scale.x,
			y: object.scale.y,
			z: object.scale.z
		},
		"senderId": this.senderId,
		"sentAt": Date.now()
	};

	if ( object.userData.hasOwnProperty("syncData") ) {

		// add syncData at top-level objectData, not inside userData.
		var syncDataClone = JSON.parse( JSON.stringify( object.userData.syncData ));
		objectData.syncData = syncDataClone;

	}

	return objectData;
}

FirebaseSync.prototype._sameObjectData = function( object, objectData ) {

	if ( object.position.x !== objectData.position.x ||
		object.position.y !== objectData.position.y ||
		object.position.z !== objectData.position.z )
		return false;

	if ( object.rotation.x !== objectData.rotation.x ||
		object.rotation.y !== objectData.rotation.y ||
		object.rotation.z !== objectData.rotation.z )
		return false;

	if ( object.scale.x !== objectData.scale.x ||
		object.scale.y !== objectData.scale.y ||
		object.scale.z !== objectData.scale.z )
		return false;

	if ( object.userData.hasOwnProperty("syncData") !== 
		 objectData.hasOwnProperty("syncData"))
		return false;

	if ( object.userData.hasOwnProperty("syncData") ) {
		// objectData has syncData too since we just checked above.
		// syncData is at top-level objectData, not inside userData.
		if ( JSON.parse( JSON.stringify( object.userData.syncData )) !==
		     JSON.parse( JSON.stringify( objectData.syncData )))
		    return false;

	}
		 
	return true;
}

FirebaseSync.prototype._copyObjectData = function( object, objectData) {

	object.position.x = objectData.position.x;
	object.position.y = objectData.position.y;
	object.position.z = objectData.position.z;

	object.rotation.x = objectData.rotation.x;
	object.rotation.y = objectData.rotation.y;
	object.rotation.z = objectData.rotation.z;

	object.scale.x = objectData.scale.x;
	object.scale.y = objectData.scale.y;
	object.scale.z = objectData.scale.z;

	if ( objectData.hasOwnProperty( "syncData" )) {

		// copy top-level syncData into object.userData
		var syncDataClone = JSON.parse( JSON.stringify( objectData.syncData ));
		object.userData.syncData = syncDataClone;

	}

}


FirebaseSync.prototype._firebaseComplete = function(errorObject) {
	// Generic onCompletion handler for firebase operations.

	if (errorObject) {
		console.error("firebase operation failed", errorObject);
	}
};

FirebaseSync.prototype._firebaseCancel = function(errorObject) {
	// Generic cancelCallback for firebase "on" subscriptions.

	console.error("firebase event subscription cancelled", errorObject);
};

FirebaseSync.prototype._firebaseError = function(errorObject) {
	// Generic failureCallback or errorCallback

	console.error("firebase error", errorObject);
};

