
var SensorTag = require( "sensortag" );

var TAG_TIMEOUT = 2000;
var enableLogging = true;

var tags = {};
var tagCount = 0;
var tagNodes = {};
var tagNodeCount = 0;
var tagNodeReadyCount = 0;

var doneCallback = null;

var isScanning = false;
var isSafeToConnect = true;

function init()
{
  nobleDeviceFix( SensorTag.CC2540 );
  nobleDeviceFix( SensorTag.CC2650 );

  startScanning();
}

function addNode( node )
{
  log( "Adding node: " + node.id );
  tagNodes[ node.id ] = {
    node : node,
    ready : false
  };

  tagNodeCount++;

  var now = ( new Date() ).getTime();
  for( var id in tags )
  {
    if( !tags[ id ].used && now - tags[ id ].lastUpdated >= TAG_TIMEOUT )
    {
      removeTag( id );
      continue;
    }
    node.onNewTag( tags[id].tag , tags[id].used );
  }
}

function removeNode( node , done )
{
  log( "Removing node: " + node.id );
  tagNodeCount--;
  if( tagNodes[ node.id ].ready ) tagNodeReadyCount--;

  delete tagNodes[ node.id ];

  // Most likely a re-deploy
  // Also, make sure there's at least 1 tag to disconnect from
  if( tagNodeCount === 0 && tagCount > 0 )
  {
    log( "Removed last node: " + node.id );
    doneCallback = done;

    stopScanning();
    disconnectAll();
  }
  else done();
}

function getTags()
{
  var tagInfo = {};
  var now = ( new Date() ).getTime();
  for( var id in tags )
  {
    if( !tags[ id ].used && now - tags[ id ].lastUpdated >= TAG_TIMEOUT )
    {
      removeTag( id );
      continue;
    }
    tagInfo[ id ] = {
      rssi : tags[ id ].rssi
    };
  }
  return tagInfo;
}

function getIsScanning() { return isScanning; }

function nodeReady( node )
{
  if( tagNodes[ node.id ].ready ) return;

  log( "Node ready: " + node.id );
  tagNodes[ node.id ].ready = true;
  tagNodeReadyCount++;

  if( tagNodeCount === tagNodeReadyCount && isSafeToConnect )
  {
    connectToAll();
  }
}

function setSafe()
{
  isSafeToConnect = true;
  if( tagNodeCount === tagNodeReadyCount )
    connectToAll();
}

function startScanning()
{
  if( isScanning ) return;

  log( "Started scanning..." );
  tags = {};
  tagIDs = [];
  tagCount = 0;

  SensorTag.CC2540.SCAN_DUPLICATES = true;
  SensorTag.CC2650.SCAN_DUPLICATES = true;
  SensorTag.discoverAll( onDiscover );
  isScanning = true;
}

function stopScanning()
{
  if( !isScanning ) return;

  log( "Stopped scanning..." );
  SensorTag.stopDiscoverAll( onDiscover );
  isScanning = false;
}

function restartScanning()
{
  if( isScanning ) return;

  isSafeToConnect = false;
  if( tagCount > 0 )
  {
    for( var id in tagNodes )
      tagNodes[id].node.prepareDisconnectAll();

    disconnectAll();
  }
  else
  {
    startScanning();
  }
}

function onDiscover( tag )
{
  var now = ( new Date() ).getTime();
  if( tags.hasOwnProperty( tag.id ) )
  {
    tags[ tag.id ].lastUpdated = now;
    tags[ tag.id ].rssi = tag._peripheral.rssi;
    return;
  }

  log( "Discovered: " + tag.id );
  tags[ tag.id ] = {
    tag : tag,
    lastUpdated : now,
    rssi : tag._peripheral.rssi,
    used : false
  };
  tagCount++;

  for( var id in tagNodes )
  {
    if( tagNodes[ id ].node.onNewTag( tag , tags[ tag.id ].used ) )
    {
      tags[ tag.id ].used = true;
    }
  }
}

function removeTag( id )
{
  log( "Removed tag: " + id );
  delete tags[ id ];
  tagCount--;
}

function onDisconnect()
{
  if( tagCount === 0 ) return;

  tagCount--;
  log( "Disconnected (" + tagCount + ")" );
  if( tagCount === 0 )
  {
    if( doneCallback )
    {
      doneCallback();
      doneCallback = false;
    }
    startScanning();
  }
}

var log;
if( enableLogging ) log = function( msg ) { console.log( "[Tag Manager] " + msg ); };
else log = function() {};

function connectToAll()
{
  stopScanning();
  for( var id in tagNodes )
    tagNodes[ id ].node.startConnecting();
}

function disconnectAll()
{
  for( var id in tags )
  {
    log( "Disconnecting: " + id );
    try
    {
      if( tags[ id ].used ) tags[ id ].tag.disconnect( onDisconnect );
      else onDisconnect();
    }
    catch( e )
    {
      onDisconnect();
    }
  }
}

module.exports = {
  init : init,
  addNode : addNode,
  removeNode : removeNode,
  getTags : getTags,
  getIsScanning : getIsScanning,
  nodeReady : nodeReady,
  setSafe : setSafe,
  restartScanning : restartScanning
};

function nobleDeviceFix( constructor )
{
  constructor.deviceList = {};
  constructor._is = constructor.is;
  constructor._startScanning = constructor.startScanning;

  constructor.is = function( peripheral ) {
    if( constructor._is( peripheral ) ) {
      var device;

      if( constructor.deviceList.hasOwnProperty( peripheral.id ) )
      {
        device = constructor.deviceList[ peripheral.id ];
      }
      else
      {
        device = new constructor(peripheral);
        constructor.deviceList[ peripheral.id ] = device;
      }

      constructor.emitter.emit( "discover" , device );
    }

    return false;
  };

  constructor.startScanning = function() {
    constructor.deviceList = {};
    constructor._startScanning();
  };
}
