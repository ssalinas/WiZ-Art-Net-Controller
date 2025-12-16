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
    this.lastSentDmxValues = {}; // Track last values per fixture to avoid redundant updates
    this.lastReceivedDmxValues = {}; // Track last values per fixture to avoid redundant updates
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
      //console.log(`UDP response from ${rinfo.address}:${rinfo.port}: ${msg}`);
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
        this.lastReceivedDmxValues[device.macAddress] = { r: 0, g: 0, b: 0, c: 0, w: 0, dimming: 0, state: false };
        this.lastSentDmxValues[device.macAddress] = { r: 0, g: 0, b: 0, c: 0, w: 0, dimming: 0, state: false };
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
      const lastValues = this.lastReceivedDmxValues[device.macAddress];
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
      this.enqueueMessage(device, r, g, b, c, w, dimming, state);
      this.lastReceivedDmxValues[device.macAddress] = {
          r: r,
          g: g,
          b: b,
          c: c,
          w: w,
          dimming: dimming,
          state: state
        };
    });
  }

  enqueueMessage(device, r, g, b, c, w, dimming, state, retryCount = 0) {
    const message = { device, r, g, b, c, w, dimming, state, retryCount };
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

  verifyState(device, expectedState, timeout = 1000) {
    return new Promise((resolve) => {
      const getPilotMsg = JSON.stringify({
        method: 'getPilot',
        params: {}
      });

      const msgBuffer = Buffer.from(getPilotMsg);
      let responseReceived = false;

      // Set up temporary listener for response
      const responseHandler = (msg, rinfo) => {
        if (rinfo.address !== device.ipAddress) {
          return;
        }

        try {
          const response = JSON.parse(msg.toString());
          if (response.method === 'getPilot' && response.result) {
            responseReceived = true;
            const actualState = response.result.state || false;
            resolve(actualState === expectedState);
          }
        } catch (err) {
          // Ignore parse errors
        }
      };

      // Add temporary listener
      this.udpClient.on('message', responseHandler);

      // Send getPilot request
      this.udpClient.send(msgBuffer, 0, msgBuffer.length, 38899, device.ipAddress, (err) => {
        if (err) {
          console.error(`Error sending getPilot to ${device.name}:`, err.message);
          this.udpClient.removeListener('message', responseHandler);
          resolve(false); // Assume verification failed
        }
      });

      // Timeout if no response
      setTimeout(() => {
        this.udpClient.removeListener('message', responseHandler);
        if (!responseReceived) {
          console.warn(`No response from ${device.name} for state verification`);
          resolve(false);
        }
      }, timeout);
    });
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
    const lastSentValues = this.lastSentDmxValues[macAddress];
    const stateChanged = lastSentValues.state !== message.state;
    if (lastSentValues.r === message.r &&
        lastSentValues.g === message.g &&
        lastSentValues.b === message.b &&
        lastSentValues.c === message.c &&
        lastSentValues.w === message.w &&
        lastSentValues.dimming === message.dimming &&
        lastSentValues.state === message.state) {
      return; // No change, skip update
    }

    // Send message and wait for completion
    this.sendWizCommandQueued(
      message.device,
      message.r, message.g, message.b,
      message.c, message.w,
      message.dimming, message.state, stateChanged,
      async () => {
        // Callback when send completes
        this.queueStats[macAddress].sent++;

        // For critical state changes to OFF, verify the state was actually applied
        if (stateChanged && !message.state) {
          console.log(`Verifying turn-off for ${message.device.name}...`);

          // Wait a bit for the fixture to process the command
          await new Promise(resolve => setTimeout(resolve, 200));

          const verified = await this.verifyState(message.device, false, 1000);

          if (!verified && message.retryCount < 3) {
            console.warn(
              `State verification failed for ${message.device.name}, ` +
              `retrying (attempt ${message.retryCount + 1}/3)`
            );

            // Re-enqueue the message with incremented retry count
            this.processing[macAddress] = false;
            this.enqueueMessage(
              message.device,
              message.r, message.g, message.b,
              message.c, message.w,
              message.dimming, message.state,
              message.retryCount + 1
            );
            return;
          }

          if (!verified) {
            console.error(
              `State verification failed for ${message.device.name} after 3 attempts, giving up`
            );
          } else {
            console.log(`State verified successfully for ${message.device.name}`);
          }
        }

        this.processing[macAddress] = false;

        // Update lastDmxValues to track what was actually sent
        this.lastSentDmxValues[macAddress] = {
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
