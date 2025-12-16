const dgram = require('dgram');
const os = require('os');
const artNet = require('artnet-protocol');
const storage = require('./storage');

// Get local IP address
function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip internal and non-IPv4 addresses
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '0.0.0.0';
}

class ArtNetWizBridge {
  constructor() {
    this.devices = [];
    this.udpClient = dgram.createSocket('udp4');
    this.controller = new artNet.ArtNetController();
    this.lastDmxValues = {}; // Track last values per fixture to avoid redundant updates
    this.messageQueues = {}; // Per-fixture message queues
    this.processing = {}; // Per-fixture processing flags
    this.queueStats = {}; // Per-fixture stats
    this.localIp = getLocalIpAddress();

    this.setupUdpClient();
  }

  setupUdpClient() {
    this.udpClient.on('error', (err) => {
      console.error(`UDP client error: ${err.stack}`);
    });

    this.udpClient.on('message', (msg, rinfo) => {
      console.debug(`UDP response from ${rinfo.address}:${rinfo.port}: ${msg}`);
    });

    this.udpClient.on('listening', () => {
      const address = this.udpClient.address();
      console.log(`UDP client listening on ${address.address}:${address.port}`);
    });

    this.udpClient.bind(38899);
  }

  async loadDevices() {
    try {
      this.devices = await storage.readAll();
      console.log(`Loaded ${this.devices.length} devices from database`);

      // Initialize last values and queue structures for each device
      this.devices.forEach(device => {
        this.lastDmxValues[device.macAddress] = { r: 0, g: 0, b: 0, c: 0, w: 0, dimming: 0, state: false };

        // Initialize queue structures if not already present
        if (!this.messageQueues[device.macAddress]) {
          this.messageQueues[device.macAddress] = [];
          this.processing[device.macAddress] = false;
          this.queueStats[device.macAddress] = { queued: 0, sent: 0, dropped: 0 };
        }
      });
    } catch (err) {
      console.error('Error loading devices:', err);
    }
  }

  start() {
    console.log(`Starting Art-Net to WiZ bridge on ${this.localIp}`);

    // Load devices initially
    this.loadDevices();

    // Reload devices every 60 seconds to pick up changes
    setInterval(() => {
      this.loadDevices();
    }, 60000);

    // Log queue stats every 30 seconds
    setInterval(() => {
      Object.keys(this.queueStats).forEach(mac => {
        const stats = this.queueStats[mac];
        const queueLength = this.messageQueues[mac] ? this.messageQueues[mac].length : 0;
        if (stats.queued > 0 || stats.dropped > 0 || queueLength > 0) {
          console.log(
            `[Queue Stats] ${mac}: ` +
            `Queued: ${stats.queued}, Sent: ${stats.sent}, Dropped: ${stats.dropped}, ` +
            `Current Queue Length: ${queueLength}`
          );
        }
      });
    }, 30000);

    // Bind Art-Net controller to local IP
    this.controller.bind(this.localIp);
    console.log(`Art-Net controller bound to ${this.localIp}`);

    // Listen for DMX data
    this.controller.on('dmx', (dmx) => {
      this.handleDmxData(dmx);
    });
  }

  handleDmxData(dmx) {
    if (dmx.universe != 0) {
      return;
    }
    // Process each device
    this.devices.forEach(device => {
      const channel = device.channel;

      // Get 6 consecutive channels: R, G, B, C, W, Dimmer
      const r = dmx.data[channel - 1] || 0;
      const g = dmx.data[channel] || 0;
      const b = dmx.data[channel + 1] || 0;
      const c = dmx.data[channel + 2] || 0;
      const w = dmx.data[channel + 3] || 0;
      const dimmerRaw = dmx.data[channel + 4] || 0;

      // Convert dimmer from 0-255 to 0-100
      const dimming = Math.round((dimmerRaw / 255) * 100);
      const state = dimming > 0;

      // Check if values have changed for this device (comparing against last SENT values)
      const lastValues = this.lastDmxValues[device.macAddress];
      if (lastValues.r === r &&
          lastValues.g === g &&
          lastValues.b === b &&
          lastValues.c === c &&
          lastValues.w === w &&
          lastValues.dimming === dimming &&
          lastValues.state === state) {
        return; // No change, skip update
      }

      // Enqueue message with raw DMX values
      // Don't update lastDmxValues here - it will be updated after message is actually sent
      this.enqueueMessage(device, r, g, b, c, w, dimming, state);
    });
  }

  enqueueMessage(device, r, g, b, c, w, dimming, state) {
    const message = { device, r, g, b, c, w, dimming, state };
    const queue = this.messageQueues[device.macAddress];

    // Queue size limit to prevent memory issues (drop oldest if > 10)
    if (queue.length >= 10) {
      queue.shift(); // Drop oldest message
      this.queueStats[device.macAddress].dropped++;
      console.warn(`Queue full for ${device.name}, dropping oldest message`);
    }

    queue.push(message);
    this.queueStats[device.macAddress].queued++;

    // Start processing if not already processing
    this.processQueue(device.macAddress);
  }

  processQueue(macAddress) {
    // If already processing this fixture, return (will be called after current message completes)
    if (this.processing[macAddress]) {
      return;
    }

    const queue = this.messageQueues[macAddress];

    // If queue is empty, nothing to do
    if (queue.length === 0) {
      return;
    }

    // Mark as processing
    this.processing[macAddress] = true;

    // Get next message
    const message = queue.shift();

    // Calculate stateChanged based on last SENT state
    const lastSentValues = this.lastDmxValues[macAddress];
    const stateChanged = lastSentValues.state !== message.state;

    // Send message and wait for completion
    this.sendWizCommandQueued(
      message.device,
      message.r, message.g, message.b,
      message.c, message.w,
      message.dimming, message.state, stateChanged,
      () => {
        // Callback when send completes
        this.queueStats[macAddress].sent++;
        this.processing[macAddress] = false;

        // Update lastDmxValues to track what was actually sent
        this.lastDmxValues[macAddress] = {
          r: message.r,
          g: message.g,
          b: message.b,
          c: message.c,
          w: message.w,
          dimming: message.dimming,
          state: message.state
        };

        // Process next message in queue
        this.processQueue(macAddress);
      }
    );
  }

  sendWizCommandQueued(device, r, g, b, c, w, dimming, state, stateChanged, callback) {
    if (!state && !stateChanged) {
      // Skip sending but still call callback to continue queue processing
      if (callback) callback();
      return;
    }
    const params = {
      r: r,
      g: g,
      b: b,
      dimming: dimming,
      state: state
    };

    // Add c (cool white) if non-zero
    if (c > 0) {
      params.c = c;
    }

    // Add w (warm white) if non-zero
    if (w > 0) {
      params.w = w;
    }

    const message = {
      id: 1,
      method: 'setPilot',
      params: params
    };

    const msgBuffer = Buffer.from(JSON.stringify(message));

    this.udpClient.send(
      msgBuffer,
      0,
      msgBuffer.length,
      38899,
      device.ipAddress,
      (err) => {
        if (err) {
          console.error(`Error sending to ${device.name} (${device.ipAddress}):`, err.message);
        } else {
          console.log(
            `Sent to ${device.name} (${device.ipAddress}): ` +
            `RGB(${r}, ${g}, ${b}) C: ${c} W: ${w} Dimming: ${dimming}% State: ${state}`
          );
        }

        // Call callback to signal completion
        if (callback) callback();
      }
    );
  }

  stop() {
    console.log('Stopping Art-Net to WiZ bridge');
    this.udpClient.close();
    this.controller.close();
  }
}

// Create and start the bridge
const bridge = new ArtNetWizBridge();
bridge.start();

// Handle shutdown
process.on('SIGINT', () => {
  bridge.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  bridge.stop();
  process.exit(0);
});
