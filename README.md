# WiZ Art-Net Controller

Control WiZ smart light fixtures using DMX over Art-Net protocol. This application provides a web interface for managing WiZ fixtures and automatically bridges Art-Net DMX data to control them.

This is a project I created for a local church with smart lights that also doubles as a theater stage. It's meant to be tiny and run on a raspberry pi.

## Features

- **Device Management**: Create, read, update, and delete WiZ fixture configurations
- **Auto-Discovery**: Scan your network to find WiZ fixtures automatically
- **Art-Net Bridge**: Daemon process that maps DMX channels to WiZ fixtures in real-time
- **Web Interface**: Clean, responsive UI for managing fixtures and monitoring status
- **Auto-Restart**: Art-Net daemon automatically restarts on failure with exponential backoff
- **JSON Storage**: Simple file-based storage for device configurations

## Installation

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the server:
   ```bash
   npm start
   ```

3. Open your browser to:
   ```
   http://localhost:3000
   ```

## Usage

### Discovering WiZ Fixtures

1. Click **Scan Network** in the "Discover WiZ Fixtures" section
2. Wait 3 seconds for the scan to complete
3. Found fixtures will appear with their MAC address, IP, and status
4. Click **Add** next to a discovered fixture to pre-fill the form
5. Set the DMX channel number and click **Add Device**

### Managing Fixtures

Each fixture requires:
- **MAC Address**: Unique identifier (cannot be changed after creation)
- **IP Address**: Current network IP
- **Name**: Friendly name for the fixture
- **Type**: Fixture type (e.g., "WiZ RGB", "WiZ Tunable")
- **Channel**: Starting DMX channel (uses 6 consecutive channels for full control)

### Art-Net Bridge

The Art-Net daemon automatically starts with the server and:
- Listens for Art-Net DMX data on your local IP
- Maps DMX channels to WiZ fixtures based on database configuration
- Each fixture uses 6 consecutive DMX channels
- Reloads device configuration every 60 seconds

**DMX Channel Mapping (per fixture):**
Each fixture uses 6 consecutive channels starting at the configured channel number:
1. **Channel + 0**: Red (0-255)
2. **Channel + 1**: Green (0-255)
3. **Channel + 2**: Blue (0-255)
4. **Channel + 3**: Cool White (0-255)
5. **Channel + 4**: Warm White (0-255)
6. **Channel + 5**: Dimmer/Brightness (0-255, converted to 0-100%)

**DMX Mapping Examples:**
- Fixture 1 on channel 1: Uses DMX channels 1-6 (R, G, B, C, W, Dimmer)
- Fixture 2 on channel 10: Uses DMX channels 10-15 (R, G, B, C, W, Dimmer)
- Fixture 3 on channel 20: Uses DMX channels 20-25 (R, G, B, C, W, Dimmer)

### Daemon Controls

- **Start**: Manually start the Art-Net daemon
- **Stop**: Stop the Art-Net daemon (disables DMX control)
- Status indicator shows running state and restart count

## Architecture

### Components

1. **server.js**: Express backend with REST API and daemon management
2. **storage.js**: JSON file-based storage module
3. **wiz-discovery.js**: UDP broadcast discovery for WiZ fixtures
4. **artnet-daemon.js**: Art-Net to WiZ bridge process
5. **public/index.html**: Frontend web interface

### API Endpoints

- `GET /api/devices` - List all devices
- `GET /api/devices/:macAddress` - Get specific device
- `POST /api/devices` - Create new device
- `PUT /api/devices/:macAddress` - Update device
- `DELETE /api/devices/:macAddress` - Delete device
- `POST /api/discover` - Discover WiZ fixtures
- `GET /api/artnet/status` - Get daemon status
- `POST /api/artnet/start` - Start daemon
- `POST /api/artnet/stop` - Stop daemon

### Data Storage

Devices are stored as individual JSON files in the `data/` directory:
- Filename: `{MAC-ADDRESS}.json`
- Auto-created on first run

## WiZ Protocol Reference

The application communicates with WiZ fixtures using JSON over UDP port 38899:

**Get Status:**
```json
{"method":"getPilot","params":{}}
```

**Set RGB Color:**
```json
{
  "id":1,
  "method":"setPilot",
  "params":{
    "r":255,
    "g":0,
    "b":0,
    "dimming":100
  }
}
```

**Set RGB with Cool/Warm White:**
```json
{
  "id":1,
  "method":"setPilot",
  "params":{
    "r":255,
    "g":128,
    "b":0,
    "c":100,
    "w":50,
    "dimming":80
  }
}
```

**Parameters:**
- `r`, `g`, `b`: Red, Green, Blue values (0-255)
- `c`: Cool white intensity (0-255)
- `w`: Warm white intensity (0-255)
- `dimming`: Overall brightness percentage (0-100)

## License

MIT
