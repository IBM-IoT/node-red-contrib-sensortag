function clamp( v , min , max ) {
	return ( v < min ? min : ( v > max ? max : v ) );
}

module.exports = function( RED ) {

	var SensorTag = require( "sensortag" );
	var libMAC = require( "getmac" );

	var Manager = require( "./sensorTagManager.js" );

	Manager.init();

	function SensorTagNode( n ) {

		RED.nodes.createNode( this , n );
		var self = this;

		this.DEFAULT_SENSOR_FREQ = 1000;

		this.deviceFilter = n.devices;

		this.temperature = n.temperature;
		this.pressure = n.pressure;
		this.humidity = n.humidity;
		this.accelerometer = n.accelerometer;
		this.magnetometer = n.magnetometer;
		this.gyroscope = n.gyroscope;
		this.luxometer = n.luxometer;
		this.keys = n.keys;

		this.magnetometerPeriod = this.accelerometerPeriod = this.gyroscopePeriod = this.luxometerPeriod = this.DEFAULT_SENSOR_FREQ;

		if( n.magnetometerPeriod ) this.magnetometerPeriod = clamp( n.magnetometerPeriod , 10 , 2550 );
		if( n.accelerometerPeriod ) this.accelerometerPeriod = clamp( n.accelerometerPeriod , 10 , 2550 );
		if( n.gyroscopePeriod ) this.gyroscopePeriod = clamp( n.gyroscopePeriod , 10 , 2550 );
		if( n.luxometerPeriod ) this.luxometerPeriod = clamp( n.luxometerPeriod , 10 , 2550 );

		var tagOptionFields = [ "temperature" , "pressure" , "humidity" , "accelerometer" , "magnetometer" , "gyroscope" , "luxometer" , "keys" ,
		                        "magnetometerPeriod" , "accelerometerPeriod" , "gyroscopePeriod" , "luxometerPeriod" ];

		this.tagOptions = {};
		for( var i in tagOptionFields )
			this.tagOptions[ tagOptionFields[i] ] = this[ tagOptionFields[i] ];

		this.name = n.name;

		this.tags = [];
		this.connectedTagCount = 0;
		this.isConnected = false;

		this.macPrefix = "";

		if( this.deviceFilter.length > 0 ) this.updateStatus( "yellow" , "Waiting for tags..." );
		else this.updateStatus( "red" , "No tags configured." );

		this.on( "close" , function( done ) {
			self.prepareDisconnectAll();

			Manager.removeNode( self , done );
		} );

		libMAC.getMac( function( err , macAddress ) {
			if( !err ) self.macPrefix = macAddress.replace( /:/gi , "" ) + ".";

			Manager.addNode( self );
		} );
	}

	RED.nodes.registerType( "sensorTag" , SensorTagNode );

	SensorTagNode.prototype.sendData = function( uuid , sensorName , sensorID , data )
	{
		var now = ( new Date() ).getTime();

		this.send( {
			sensor: sensorName,
			payload: {
				id: this.macPrefix + uuid + "." + sensorID,
				tstamp: { $date : now },
				json_data: data
			}
		} );
	};

	SensorTagNode.prototype.onTagConnect = function( tag ) {
		this.connectedTagCount++;
		this.updateStatusConnected();
	};

	SensorTagNode.prototype.onTagDisconnect = function( tag ) {
		this.connectedTagCount--;
		this.updateStatusConnected();
	};

	SensorTagNode.prototype.updateStatus = function( color , message ) {
		this.status( {
			fill : color,
			shape : "dot",
			text : message
		} );
	};

	SensorTagNode.prototype.updateStatusConnected = function()
	{
		this.updateStatus( "green" , "Connected: " + this.connectedTagCount + "/" + this.tags.length );
	};

	SensorTagNode.prototype.onNewTag = function( newTag , isUsed )
	{
		if( this.deviceFilter.indexOf( newTag.id ) === -1 ) return false;

		if( isUsed )
		{
			this.updateStatus( "red" , "Tag already used" );
			return false;
		}

		var tag = new Tag( this , newTag , this.tagOptions );
		this.tags.push( tag );

		if( this.tags.length === this.deviceFilter.length )
		{
			// Give other nodes a chance to initialize
			var self = this;
			setTimeout( function() {
				Manager.nodeReady( self );
			} , 1000 );
		}

		return true;
	};

	SensorTagNode.prototype.startConnecting = function()
	{
		if( this.isConnected ) return;
		if( this.tags.length < 1 ) return;

		this.log( "Connecting to all devices (" + this.tags.length + ")..." );
		for( var i = 0; i < this.tags.length; i++ )
		{
			this.tags[i].connect();
		}

		this.isConnected = true;
	};

	SensorTagNode.prototype.prepareDisconnectAll = function()
	{
		for( var i = 0; i < this.tags.length; i++ )
			this.tags[i].attemptReconnect = false;

		this.tags = [];
		this.connectedTagCount = 0;
		this.isConnected = false;

		this.updateStatus( "red" , "Closed." );
	};

	var Tag = function( parent , tag , options )
	{
		for( var key in options )
			this[ key ] = options[ key ];

		this.parent = parent;
		this.tag = tag;

		this.attemptReconnect = true;
		this.disconnected = true;
	};

	Tag.prototype.log = function( msg )
	{
		this.parent.log( "[" + this.tag.uuid + "] " + msg );
	};

	Tag.prototype.connect = function()
	{
		if( !this.disconnected ) return;
		this.log( "Connecting..." );
		this.tag.connect( this.onConnect.bind( this ) );
	};

	Tag.prototype.onConnect = function( error )
	{
		if( error )
		{
			this.log( "Error connecting: " + error.message );

			if( this.attemptReconnect )
			{
				if( error.message.indexOf( "Device or resource busy" ) != -1 )
				{
					var self = this;
					this.tag.disconnect( function() {
						self.connect();
					} );
				}
				else
				{
					setTimeout( this.connect.bind( this ) , 5000 );
				}
			}

			return;
		}

		this.disconnected = false;
		this.tag.on( "disconnect" , this.onDisconnect.bind( this ) );
		this.parent.onTagConnect( this );

		this.log( "Connected." );
		this.tag.discoverServicesAndCharacteristics( this.discoverServCharCallback.bind( this ) );
	};

	Tag.prototype.discoverServCharCallback = function( error )
	{
		if( error )
		{
			this.log( "Error getting services & characteristics: " + error.message );
			return;
		}

		if( this.disconnected ) return;

		if( this.temperature )
		{
			this.tag.enableIrTemperature( this.errorHandler.bind( this ) );
			this.tag.on( "irTemperatureChange" , this.onIrTemperatureChange.bind( this ) );
			this.tag.notifyIrTemperature( this.errorHandler.bind( this ) );
		}

		if( this.accelerometer )
		{
			this.tag.enableAccelerometer( this.errorHandler.bind( this ) );
			this.tag.setAccelerometerPeriod( this.accelerometerPeriod , this.errorHandler.bind( this ) );
			this.tag.on( "accelerometerChange" , this.onAccelerometerChange.bind( this ) );
			this.tag.notifyAccelerometer( this.errorHandler.bind( this ) );
		}

		if( this.humidity )
		{
			this.tag.enableHumidity( this.errorHandler.bind( this ) );
			this.tag.on( "humidityChange" , this.onHumidityChange.bind( this ) );
			this.tag.notifyHumidity( this.errorHandler.bind( this ) );
		}

		if( this.magnetometer )
		{
			this.tag.enableMagnetometer( this.errorHandler.bind( this ) );
			this.tag.setMagnetometerPeriod( this.magnetometerPeriod , this.errorHandler.bind( this ) );
			this.tag.on( "magnetometerChange" , this.onMagnetometerChange.bind( this ) );
			this.tag.notifyMagnetometer( this.errorHandler.bind( this ) );
		}

		if( this.pressure )
		{
			this.tag.enableBarometricPressure( this.errorHandler.bind( this ) );
			this.tag.on( "barometricPressureChange" , this.onPressureChange.bind( this ) );
			this.tag.notifyBarometricPressure( this.errorHandler.bind( this ) );
		}

		if( this.gyroscope )
		{
			this.tag.enableGyroscope( this.errorHandler.bind( this ) );
			this.tag.setGyroscopePeriod( this.gyroscopePeriod , this.errorHandler.bind( this ) );
			this.tag.on( "gyroscopeChange" , this.onGyroscopeChange.bind( this ) );
			this.tag.notifyGyroscope( this.errorHandler.bind( this ) );
		}

		if( this.luxometer && this.type == "cc2650" )
		{
			this.tag.enableLuxometer( this.errorHandler.bind( this ) );
			this.tag.setLuxometerPeriod( this.luxometerPeriod , this.errorHandler.bind( this ) );
			this.tag.on( "luxometerChange" , this.onLuxometerChange.bind( this ) );
			this.tag.notifyLuxometer( this.errorHandler.bind( this ) );
		}

		if( this.keys )
		{
			this.tag.on( "simpleKeyChange" , this.onKeyChange.bind( this ) );
			this.tag.notifySimpleKey( this.errorHandler.bind( this ) );
		}
	};

	Tag.prototype.onDisconnect = function()
	{
		if( this.disconnected ) return;
		this.disconnected = true;

		if( this.attemptReconnect )
		{
			this.parent.onTagDisconnect( this );
			this.log( "Attempting to reconnect in 5s..." );
			setTimeout( this.connect.bind( this ) , 5000 );
		}
	};

	Tag.prototype.onIrTemperatureChange = function( object , ambient )
	{
		this.parent.sendData( this.tag.uuid , "temperature" , 0 , {
			object : object,
			ambient : ambient
		} );
	};

	Tag.prototype.onAccelerometerChange = function( x , y , z )
	{
		this.parent.sendData( this.tag.uuid , "accelerometer" , 1 , {
			x : x,
			y : y,
			z : z
		} );
	};

	Tag.prototype.onHumidityChange = function( temperature , humidity )
	{
		this.parent.sendData( this.tag.uuid , "humidity" , 2 , {
			temperature : temperature,
			humidity : humidity
		} );
	};

	Tag.prototype.onMagnetometerChange = function( x , y , z )
	{
		this.parent.sendData( this.tag.uuid , "magnetometer" , 3 , {
			x : x,
			y : y,
			z : z
		} );
	};

	Tag.prototype.onPressureChange = function( pressure )
	{
		this.parent.sendData( this.tag.uuid , "pressure" , 4 , {
			pressure : pressure
		} );
	};

	Tag.prototype.onGyroscopeChange = function( x , y , z )
	{
		this.parent.sendData( this.tag.uuid , "gyroscope" , 5 , {
			x : x,
			y : y,
			z : z
		} );
	};

	Tag.prototype.onLuxometerChange = function( lux )
	{
		this.parent.sendData( this.tag.uuid , "luxometer" , 6 , {
			lux : lux
		} );
	};

	Tag.prototype.onKeyChange = function( left , right )
	{
		this.parent.sendData( this.tag.uuid , "keys" , 7 , {
			key1 : left,
			key2 : right
		} );
	};

	Tag.prototype.errorHandler = function( error )
	{
		if( error )
		{
			this.log( "Error: " + error.message );
		}
	};

	// Sensor Tag Discovery API

	RED.httpNode.get( "/sensortag/safe" , function( request , response ) {
		Manager.setSafe();
		response.send( 200 );
	} );

	RED.httpNode.get( "/sensortag/isscanning" , function( request , response ) {
		response.setHeader( "Content-Type" , "application/json" );
		response.end( JSON.stringify( { scanning : Manager.getIsScanning() } ) );
	} );

	RED.httpNode.get( "/sensortag/restart" , function( request , response ) {
		Manager.restartScanning();
		response.send( 200 );
	} );

	RED.httpNode.get( "/sensortag/tags" , function( request , response ) {
		response.setHeader( "Content-Type" , "application/json" );
		response.end( JSON.stringify( Manager.getTags() ) );
	} );
};
