function clamp( v , min , max ) {
	return ( v < min ? min : ( v > max ? max : v ) );
}

module.exports = function( RED ) {

	var events = require('events');
	var SensorTag = require('sensortag');
	var crypto = require('crypto'); // For random
	var util = require('util');

	var registeredST = [];

	function SensorTagNode(n) {

		this.showDebug = true;

		RED.nodes.createNode(this,n);

		this.DEFAULT_FREQ_SENSOR = 1000;

		if(n.uuid === "")
			this.uuid = undefined;
		else
			this.uuid = n.uuid;

		this.temperature = n.temperature;
		this.pressure = n.pressure;
		this.humidity = n.humidity;
		this.accelerometer = n.accelerometer;
		this.magnetometer = n.magnetometer;
		this.gyroscope = n.gyroscope;
		this.luxometer = n.luxometer;
		this.keys = n.keys;

		if(n.magnetometerPeriod !== "")
			this.magnPeriode = clamp( n.magnetometerPeriod , 1 , 2550 );
		else
			this.magnPeriode = this.DEFAULT_FREQ_SENSOR;

		if(n.accelerometerPeriod !== "")
			this.accPeriode = clamp( n.accelerometerPeriod , 1 , 2550 );
		else
			this.accPeriode = this.DEFAULT_FREQ_SENSOR;

		if(n.gyroscopePeriod !== "")
			this.gyrPeriode = clamp( n.gyroscopePeriod , 100 , 2550 );
		else
			this.gyrPeriode = this.DEFAULT_FREQ_SENSOR;

		this.luxometerPeriod = n.luxometerPeriod || this.DEFAULT_FREQ_SENSOR;

		/**
		 * Define the status of the sensor
		 * Possible values are : 'init', 'scan', 'connecting', 'connected', 'disconnecting', 'disconnected', 'error', 'fixing', 'closed'
		 */
		this.stat = null;

		this.name = n.name;
		this.topic = n.topic;
		// TODO: Make boolean
		this.active = "enable";

		this.connKey = -1;

		this.error = false;
		this.contScan = true;

		this.TIME_CLEAN = 5000;
		this.clean = undefined;

		this.updateStatus('init','red');

		this.scanDevice();
	}

	RED.nodes.registerType("sensorTag",SensorTagNode);

	SensorTagNode.prototype.updateStatus = function(s,c){
		var oldState = this.stat;
		this.stat = s;
		this.status({fill: c, shape: "dot", text:this.stat});
		this.sendState();
		this.log("Changed State from "+ oldState+" to "+s);
	};

	SensorTagNode.prototype.scanDevice = function (){
		this.log("In scan");
		if(typeof this.stag !== "undefined"){
			this.log("Deleted old object");
			this.stag.removeAllListeners();
			this.stag = undefined;
		}

		if(this.stat === 'init' || this.stat === 'disconnected' || this.stat === 'error'){
			this.updateStatus('scan', 'yellow');
			this.log("Launch Discovering");
			if(this.uuid)
				SensorTag.discover(this.connect.bind(this), this.uuid);
			else
				SensorTag.discover(this.connect.bind(this));
		}
	};

	SensorTagNode.prototype.enableDisable = function (connKeyC) {
		// For each sensor : Enable the sensor,
		//add a callback on value change, notify
		// on this sensor if the user enabled it

		this.log("In enableDisable");

		if(!this.error){
			if(this.connKey == connKeyC){
				// Temperature
				if(this.temperature){
					this.stag.enableIrTemperature(function(){});
					this.stag.on('irTemperatureChange',this.onTempChange.bind(this));
					this.stag.notifyIrTemperature(function(){});
				}

				// Barometer
				if(this.pressure){
					this.stag.enableBarometricPressure(function(){});
					this.stag.on('barometricPressureChange', this.onBarChange.bind(this));
					this.stag.notifyBarometricPressure(function(){});
				}

				// Hygrometer
				if(this.humidity){
					this.stag.enableHumidity(function(){});
					this.stag.on('humidityChange', this.onHumidityChange.bind(this));
					this.stag.notifyHumidity(function() {});
				}

				// Accelerometer
				if(this.accelerometer){
					this.stag.enableAccelerometer(function(){});
					this.stag.setAccelerometerPeriod(this.accPeriode, function(){});
					this.stag.on('accelerometerChange', this.onAccChange.bind(this));
					this.stag.notifyAccelerometer(function() {});
				}

				// Magnetometer
				if(this.magnetometer){
					this.stag.enableMagnetometer(function() {});
					this.stag.setMagnetometerPeriod(this.magnPeriode, function(){});
					this.stag.on('magnetometerChange', this.onMagnChange.bind(this));
					this.stag.notifyMagnetometer(function() {});
				}

				// Gyroscope
				if(this.gyroscope){
					this.stag.enableGyroscope(function(){});
					this.stag.setGyroscopePeriod(this.gyrPeriode,function(){});
					this.stag.on('gyroscopeChange', this.ongyrChange.bind(this));
					this.stag.notifyGyroscope(function() {});
				}

				// Luxometer
				if( this.luxometer && this.stag.type === "cc2650" ) {
					this.stag.enableLuxometer(function(){});
					this.stag.setLuxometerPeriod( this.luxometerPeriod , function() {} );
					this.stag.on('luxometerChange',this.onLuxometerChange.bind(this));
					this.stag.notifyLuxometer(function(){});
				}

				// Keys
				if(this.keys){
					this.stag.on('simpleKeyChange', this.onKeyChange.bind(this));
					this.stag.notifySimpleKey(function() {});
				}

				// Update status
				this.updateStatus('connected', 'green');
			}else{
				this.error = true;
				this.updateStatus('error', 'red');
			}
		}
		else
		{
			this.clean = setTimeout( this.cleanListeners.bind( this ) , this.TIME_CLEAN );
		}

		this.log( "End enableDisable" );
	};

	SensorTagNode.prototype.cleanListeners = function ()
	{
		var nbListener;
		var i;

		this.updateStatus('fixing', 'yellow');
		this.log("Clean listeners");

		if(this.stag){
			// Scan services and characteristics
			this.stag.discoverServicesAndCharacteristics((function(){

				// Temperature
				if(this.temperature){
					nbListener = events.EventEmitter.listenerCount(this.stag, 'irTemperatureChange');
					// Clean
					for(i=0;i< nbListener;i++)
						this.stag.removeListener('irTemperatureChange', this.onTempChange.bind(this));

					// And add new one
					this.stag.enableIrTemperature(function(){});
					this.stag.on('irTemperatureChange',this.onTempChange.bind(this));
					this.stag.notifyIrTemperature(function(){});
				}

				// Barometer
				if(this.pressure){
					nbListener = events.EventEmitter.listenerCount(this.stag, 'barometricPressureChange');
					// Clean
					for(i=0;i< nbListener;i++)
						this.stag.removeListener('barometricPressureChange', this.onBarChange.bind(this));

					this.stag.enableBarometricPressure(function(){});
					this.stag.on('barometricPressureChange', this.onBarChange.bind(this));
					this.stag.notifyBarometricPressure(function(){});
				}

				// Hygrometer
				if(this.humidity){
					nbListener = events.EventEmitter.listenerCount(this.stag, 'humidityChange');
					// Clean
					for(i=0;i< nbListener;i++)
						this.stag.removeListener('humidityChange', this.onHumidityChange.bind(this));

					this.stag.enableHumidity(function(){});
					this.stag.on('humidityChange', this.onHumidityChange.bind(this));
					this.stag.notifyHumidity(function() {});
				}

				// accelerometer
				if(this.accelerometer){
					nbListener = events.EventEmitter.listenerCount(this.stag, 'accelerometerChange');
					// Clean
					for(i=0;i< nbListener;i++)
						this.stag.removeListener('accelerometerChange', this.onAccChange.bind(this));

					this.stag.enableAccelerometer(function(){});
					this.stag.on('accelerometerChange', this.onAccChange.bind(this));
					this.stag.notifyAccelerometer(function() {});
				}

				// magnetometer
				if(this.magnetometer){
					nbListener = events.EventEmitter.listenerCount(this.stag, 'magnetometerChange');
					// Clean
					for(i=0;i< nbListener;i++)
						this.stag.removeListener('magnetometerChange', this.onMagnChange.bind(this));

					this.stag.enableMagnetometer(function() {});
					this.stag.on('magnetometerChange', this.onMagnChange.bind(this));
					this.stag.notifyMagnetometer(function() {});
				}

				// Gyroscope
				if(this.gyroscope){
					nbListener = events.EventEmitter.listenerCount(this.stag, 'gyroscopeChange');
					// Clean
					for(i=0;i< nbListener;i++)
						this.stag.removeListener('gyroscopeChange', this.ongyrChange.bind(this));


					this.stag.enableGyroscope(function(){});
					this.stag.on('gyroscopeChange', this.ongyrChange.bind(this));
					this.stag.notifyGyroscope(function() {});
				}

				// Luxometer
				if( this.luxometer && this.stag.type === "cc2650" ) {
					nbListener = events.EventEmitter.listenerCount(this.stag, 'luxometerChange');
					// Clean
					for(i=0;i< nbListener;i++)
						this.stag.removeListener('luxometerChange', this.onLuxometerChange.bind(this));

					// And add new one
					this.stag.enableLuxometer(function(){});
					this.stag.on('luxometerChange',this.onLuxometerChange.bind(this));
					this.stag.notifyLuxometer(function(){});
				}

				// Keys
				if(this.keys){
					nbListener = events.EventEmitter.listenerCount(this.stag, 'simpleKeyChange');

					// Clean
					for(i=0;i< nbListener;i++)
						this.stag.removeListener('simpleKeyChange', this.onKeyChange.bind(this));

					// And add new one
					this.stag.on('simpleKeyChange', this.onKeyChange.bind(this));
					this.stag.notifySimpleKey(function() {});
				}

				this.error = false;

				this.updateStatus('connected', 'green');
			}).bind(this));
		}else{
			this.updateStatus('black', 'error');
			this.scanDevice();
		}

		this.log("End clean listeners");
	};

	SensorTagNode.prototype.close = function(){
		this.stat = "closed";
		this.log("Node Closed");
		if(typeof this.stag !== "undefined"){
			this.contScan = false;
			if(this.stag)
				this.stag.disconnect();
		}
	};

	SensorTagNode.prototype.sendState = function (){
		this.send({
			"uuid" : this.uuid,
			"state" : this.stat
		});
	};

	/**
	 * Send data in adding the current state and the uuid
	 * @param msg The msg to send
	 */
	SensorTagNode.prototype.sendData = function(msg){
		msg.uuid = this.uuid;
		msg.state = this.stat;
		this.send(msg);
		//this.log("<MSG> :" + JSON.stringify(msg));
	};

	/**
	 * Log properly the msg given in argument
	 */
	SensorTagNode.prototype.log = function(msg){
		if( this.showDebug )
		{
			util.log("[SensorTag]["+this.id+"]["+this.stat+"]"+" : "+ msg);
		}
	};

	SensorTagNode.prototype.connect = function( sensorTag )
	{
		this.log( "Connected: " + sensorTag.type );
		if( this.stat === "closed" ) return;

		// If try to disconnect
		if(this.stat === 'scan'){
			this.log("Operate before connect to " + sensorTag.uuid);
			this.uuid = sensorTag.uuid;

			if(registeredST.indexOf(this.uuid) == -1){ // If not already exist
				// registeredST.push(this.uuid);

				this.updateStatus('connecting', 'yellow');
				this.error = false;

				this.connKey = crypto.randomBytes(1)[0]; // Take just the first random byte
				var connKeyC = this.connKey; // Connection key for identifying the context

				// Fill the object inside the node for stors the information
				this.stag = sensorTag;

				// Added callback on disconnect
				this.stag.on('disconnect', this.disconnect.bind(this));

				// Connect to the sensor found
				this.stag.connect((function(){
					this.log("Try to connect");
					// Enable/Disable functionalities
					this.stag.discoverServicesAndCharacteristics((function(){
						this.enableDisable(connKeyC); // Enable/disable functionalities asked by the user
					}).bind(this));
				}).bind(this));
			}
			else{ // If already conencted
				this.uuid = undefined;
				this.updateStatus('error','red');
				this.scanDevice();
			}
		}
	};

	SensorTagNode.prototype.disconnect = function (){
		if(this.stat === 'connected' || this.stat === 'connecting' || this.stat === 'error' || this.stat === 'fixing'){
			this.updateStatus('disconnecting', 'yellow');

			this.log("In disconnect");

			clearTimeout(this.clean);

			if(this.stag)
				this.stag.removeAllListeners();

			delete registeredST[registeredST.indexOf(this.uuid)];

			delete this.uuid;
			this.uuid = undefined;
			delete this.stag;
			this.stag = undefined;

			this.updateStatus('disconnected', 'red');
			this.log("End Disconnecting");

			// Scanning ?
			if(this.contScan)
				this.scanDevice();
		}
	};

	SensorTagNode.prototype.onTempChange = function(objectTemperature, ambientTemperature){
		if(this.active === "enable"){
			var msg = {'topic': this.topic + '/temperature'};
			msg.payload = {'object': objectTemperature.toFixed(1),
					'ambient':ambientTemperature.toFixed(1)
			};
			this.sendData(msg);
		}
	};

	SensorTagNode.prototype.onBarChange = function(pressure){
		if(this.active === "enable"){
			var msg = {'topic': this.topic + '/pressure'};
			msg.payload = {'pres': pressure.toFixed(1)};
			this.sendData(msg);
		}
	};

	SensorTagNode.prototype.onHumidityChange = function(temp, humidity) {
		if(this.active === "enable"){
			var msg = {'topic': this.topic + '/humidity'};
			msg.payload = {'temp': temp.toFixed(1),
					'humidity': humidity.toFixed(1)
			};
			this.sendData(msg);
		}
	};

	SensorTagNode.prototype.onAccChange = function(x,y,z){
		if(this.active === "enable"){
			var msg = {'topic': this.topic + '/accelerometer'};
			msg.payload = {'x': x, 'y': y, 'z': z};
			this.sendData(msg);
		}
	};

	SensorTagNode.prototype.onMagnChange = function(x,y,z){
		if(this.active === "enable"){var msg = {'topic': this.topic + '/magnetometer'};
		msg.payload = {'x': x, 'y': y, 'z': z};
		this.sendData(msg);
		}
	};

	SensorTagNode.prototype.ongyrChange = function(x,y,z){
		if(this.active === "enable"){
			var msg = {'topic': this.topic + '/gyroscope'};
			msg.payload = {'x': x, 'y': y, 'z': z};
			this.sendData(msg);
		}
	};

	SensorTagNode.prototype.onLuxometerChange = function( lux ) {
		if( this.active === "enable" ) {
			var msg = {
				topic : this.topic + '/luxometer',
				payload : {
					lux : lux
				}
			};
			this.sendData( msg );
		}
	};

	SensorTagNode.prototype.onKeyChange = function(left, right){
		if(this.active === "enable"){
			var msg = {'topic': this.topic + '/keys'};
			msg.payload = {'left': left, 'right': right};
			this.sendData(msg);
		}
	};

	/*****************************************************************/


	/**
	 * Request from the node's button in node-red
	 */
	RED.httpAdmin.post("/sensorTag/:id/", function(req,res) {
		var node = RED.nodes.getNode(req.params.id);
		if (node !== null) {
			if (node.active === "disable") {
				node.active = "enable";
				res.send(200);
			} else if (node.active === "enable") {
				node.active = "disable";
				res.send(201);
			} else {
				res.send(404);
			}
		} else {
			res.send(404);
		}
	});
};
