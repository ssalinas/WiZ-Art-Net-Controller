const dgram = require('dgram');

async function discoverWizFixtures(timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const discoveredDevices = [];
    const seenMacs = new Set();

    socket.on('error', (err) => {
      socket.close();
      reject(err);
    });

    socket.on('message', (msg, rinfo) => {
      try {
        const response = JSON.parse(msg.toString());

        if (response.method === 'getPilot' && response.result && response.result.mac) {
          const mac = response.result.mac;

          // Only add each device once
          if (!seenMacs.has(mac)) {
            seenMacs.add(mac);
            discoveredDevices.push({
              macAddress: mac,
              ipAddress: rinfo.address,
              state: response.result.state || false,
              rssi: response.result.rssi || 0,
              dimming: response.result.dimming || 100,
              raw: response.result
            });
          }
        }
      } catch (err) {
        // Ignore malformed responses
        console.error('Error parsing response:', err.message);
      }
    });

    socket.on('listening', () => {
      socket.setBroadcast(true);

      const message = JSON.stringify({
        method: 'getPilot',
        params: {}
      });

      // Send broadcast message
      socket.send(message, 0, message.length, 38899, '255.255.255.255', (err) => {
        if (err) {
          socket.close();
          reject(err);
        }
      });

      // Set timeout to close socket and return results
      setTimeout(() => {
        socket.close();
        resolve(discoveredDevices);
      }, timeoutMs);
    });

    // Bind to a random port
    socket.bind();
  });
}

module.exports = {
  discoverWizFixtures
};
