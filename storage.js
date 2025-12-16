const fs = require('fs').promises;
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');

// Ensure data directory exists
async function ensureDataDir() {
  try {
    await fs.access(DATA_DIR);
  } catch {
    await fs.mkdir(DATA_DIR, { recursive: true });
  }
}

// Get file path for a MAC address
function getFilePath(macAddress) {
  // Sanitize MAC address for use as filename
  const sanitized = macAddress.replace(/:/g, '-');
  return path.join(DATA_DIR, `${sanitized}.json`);
}

// Create a new device
async function create(device) {
  await ensureDataDir();
  const filePath = getFilePath(device.macAddress);

  // Check if device already exists
  try {
    await fs.access(filePath);
    throw new Error('Device with this MAC address already exists');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  await fs.writeFile(filePath, JSON.stringify(device, null, 2));
  return device;
}

// Read a device by MAC address
async function read(macAddress) {
  const filePath = getFilePath(macAddress);

  try {
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

// Read all devices
async function readAll() {
  await ensureDataDir();

  try {
    const files = await fs.readdir(DATA_DIR);
    const devices = [];

    for (const file of files) {
      if (file.endsWith('.json')) {
        const data = await fs.readFile(path.join(DATA_DIR, file), 'utf-8');
        devices.push(JSON.parse(data));
      }
    }

    return devices;
  } catch (err) {
    throw err;
  }
}

// Update a device
async function update(macAddress, updates) {
  const filePath = getFilePath(macAddress);

  // Read existing device
  const existing = await read(macAddress);
  if (!existing) {
    throw new Error('Device not found');
  }

  // Prevent MAC address changes
  if (updates.macAddress && updates.macAddress !== macAddress) {
    throw new Error('Cannot change MAC address');
  }

  // Merge updates
  const updated = { ...existing, ...updates, macAddress };

  await fs.writeFile(filePath, JSON.stringify(updated, null, 2));
  return updated;
}

// Delete a device
async function remove(macAddress) {
  const filePath = getFilePath(macAddress);

  try {
    await fs.unlink(filePath);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

module.exports = {
  create,
  read,
  readAll,
  update,
  remove
};
