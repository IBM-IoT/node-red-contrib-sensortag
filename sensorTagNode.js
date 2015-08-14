function clamp( v , min , max ) {
	return ( v < min ? min : ( v > max ? max : v ) );
}

module.exports = function( RED ) {

	var SensorTag = require( "sensortag" );

	function SensorTagNode( n ) {

		RED.nodes.createNode( this , n );

		this.DEFAULT_SENSOR_FREQ = 1000;

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
		this.topic = n.topic || "sensorTag";

		this.tags = {};
		this.tagCount = 0;
		this.connectedTagCount = 0;

		this.isScanning = false;
		this.isRescanning = false;

		this.onDiscoverBound = this.onDiscover.bind( this );

		this.startScanning();

		this.on( "close" , function() {
			if( this.isScanning )
			{
				SensorTag.stopDiscoverAll( this.onDiscoverBound );
			}

			for( var id in this.tags )
				this.tags[id].disconnect();
		} );
	}

	RED.nodes.registerType( "sensorTag" , SensorTagNode );

	SensorTagNode.prototype.sendData = function( uuid , sensorName , data )
	{
		var now = ( new Date() ).getTime();

		this.send( {
			payload: {
				id: uuid,
				tstamp : { $date : now },
				sensor: sensorName,
				data: data
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

		if( this.isRescanning && this.connectedTagCount === 0 )
		{
			this.isRescanning = false;
			this.startScanning();
		}
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
		this.updateStatus( "green" , "Connected: " + this.connectedTagCount + "/" + this.tagCount );
	};

	SensorTagNode.prototype.startScanning = function()
	{
		if( this.isScanning ) return;

		this.tags = {};
		this.tagCount = 0;

		this.log( "Starting to scan..." );
		SensorTag.discoverAll( this.onDiscoverBound );
		this.isScanning = true;

		this.updateStatus( "yellow" , "Scanning..." );
	};

	SensorTagNode.prototype.onDiscover = function( discoveredTag )
	{
		// Should never happend if SCAN_DUPLICATES = false
		if( this.tags.hasOwnProperty( discoveredTag.uuid ) ) return;

		var tag = new Tag( this , discoveredTag , this.tagOptions );
		this.tags[ discoveredTag.uuid ] = tag;
		this.tagCount++;

		this.updateStatus( "yellow" , "Discovered: " + this.tagCount );
	};

	SensorTagNode.prototype.startConnecting = function()
	{
		if( this.tagCount < 1 ) return;

		SensorTag.stopDiscoverAll( this.onDiscoverBound );
		this.isScanning = false;
		this.updateStatus( "green" , "Connecting..." );

		for( var i in this.tags )
		{
			this.tags[i].connect();
		}
	};

	SensorTagNode.prototype.onNodeButtonPress = function() {
		if( !this.isScanning )
		{
			if( this.connectedTagCount === 0 ) this.startScanning();
			else
			{
				this.isRescanning = true;

				for( var i in this.tags )
				{
					this.tags[i].attemptReconnect = false;
					this.tags[i].disconnect();
				}
			}
		}
		else
		{
			this.startConnecting();
		}
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

	Tag.prototype.disconnect = function()
	{
		if( this.disconnected ) return;
		this.attemptReconnect = false;
		this.tag.disconnect();
	};

	Tag.prototype.onDisconnect = function()
	{
		if( this.disconnected ) return;
		this.disconnected = true;
		this.parent.onTagDisconnect( this );

		if( this.attemptReconnect )
		{
			setTimeout( this.connect.bind( this ) , 5000 );
		}
	};

	Tag.prototype.onIrTemperatureChange = function( object , ambient )
	{
		this.parent.sendData( this.tag.uuid , "temperature" , {
			object : object,
			ambient : ambient
		} );
	};

	Tag.prototype.onAccelerometerChange = function( x , y , z )
	{
		this.parent.sendData( this.tag.uuid , "accelerometer" , {
			x : x,
			y : y,
			z : z
		} );
	};

	Tag.prototype.onHumidityChange = function( temperature , humidity )
	{
		this.parent.sendData( this.tag.uuid , "humidity" , {
			temperature : temperature,
			humidity : humidity
		} );
	};

	Tag.prototype.onMagnetometerChange = function( x , y , z )
	{
		this.parent.sendData( this.tag.uuid , "magnetometer" , {
			x : x,
			y : y,
			z : z
		} );
	};

	Tag.prototype.onPressureChange = function( pressure )
	{
		this.parent.sendData( this.tag.uuid , "pressure" , {
			pressure : pressure
		} );
	};

	Tag.prototype.onGyroscopeChange = function( x , y , z )
	{
		this.parent.sendData( this.tag.uuid , "gyroscope" , {
			x : x,
			y : y,
			z : z
		} );
	};

	Tag.prototype.onLuxometerChange = function( lux )
	{
		this.parent.sendData( this.tag.uuid , "luxometer" , {
			lux : lux
		} );
	};

	Tag.prototype.onKeyChange = function( left , right )
	{
		this.parent.sendData( this.tag.uuid , "keys" , {
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

	// Handle Node-RED button request
	RED.httpAdmin.post( "/sensorTag/:id/" , function( req , res ) {
		var node = RED.nodes.getNode( req.params.id );
		if( node )
		{
			node.onNodeButtonPress();
			res.send( 200 );
		}
		else res.send( 404 );
	} );
};
