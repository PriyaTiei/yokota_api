const express = require('express');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const readline = require('readline');

const app = express();
const PORT = process.env.PORT || 8127;

// Station number mapping
const STATION_MAPPING = {
    61: '0255',
    60: '0240', 
    58: '0250',
    20: '0257',
    21: '0230'
};

// Subfolder mapping for each station
const SUBFOLDER_MAPPING = {
    '0230': '120_0_100_97',
    '0240': '120_0_100_99',
    '0250': '120_0_100_98',
    '0255': '120_0_100_96',
    '0257': '120_0_100_78'
};

// Base mount path
const BASE_PATH = process.env.YOKOTA_DATA_PATH || process.env.BASE_PATH || '/mnt/yokota/AppData';

app.use(express.json());

// In-Memory MTime Cache to avoid repeated disk reads & string splits
const yokotaFileCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_ENTRIES = 300;

// Helper function to extract date from datetime string
function extractDate(dateTimeString) {
    try {
        const datePart = dateTimeString.split(' ')[0];
        return datePart.replace(/-/g, '');
    } catch (error) {
        throw new Error('Invalid date format. Expected format: YYYY-MM-DD HH:MM:SS.ssssss');
    }
}

async function pathExists(p) {
    try {
        await fsp.access(p, fs.constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

// Helper function to read CSV file using streaming readline with mtime cache
async function readCSVFile(filePath) {
    const stats = await fsp.stat(filePath);
    const cached = yokotaFileCache.get(filePath);

    if (cached && cached.mtimeMs === stats.mtimeMs && (Date.now() - cached.cachedAt < CACHE_TTL_MS)) {
        return cached.data;
    }

    const parsedData = await new Promise((resolve, reject) => {
        const results = [];
        const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
        const rl = readline.createInterface({
            input: fileStream,
            crlfDelay: Infinity
        });

        rl.on('line', (line) => {
            const trimmed = line.trim();
            if (!trimmed) return;

            const fields = trimmed.split(/\s+/);
            if (fields.length >= 11) {
                results.push({
                    folder: fields[0] || '',
                    program: fields[1] || '',
                    unknownValue1: fields[2] || '',
                    torqueDuplicate: fields[3] || '',
                    unknownValue2: fields[4] || '',
                    unknownValue3: fields[5] || '',
                    unknownValue4: fields[6] || '',
                    unknownValue5: fields[7] || '',
                    torque: fields[8] || '',
                    judgement: fields[9] || '',
                    timeDate: fields.slice(10).join(' ') || ''
                });
            } else {
                results.push({
                    error: 'Unexpected format',
                    fieldCount: fields.length,
                    fields: fields
                });
            }
        });

        rl.on('close', () => {
            resolve(results);
        });

        rl.on('error', (err) => {
            reject(err);
        });
    });

    if (yokotaFileCache.size > MAX_CACHE_ENTRIES) {
        const oldestKey = yokotaFileCache.keys().next().value;
        yokotaFileCache.delete(oldestKey);
    }

    yokotaFileCache.set(filePath, {
        mtimeMs: stats.mtimeMs,
        cachedAt: Date.now(),
        data: parsedData
    });

    return parsedData;
}

// Helper function to find the correct CSV file asynchronously
async function findCSVFile(directoryPath, stationCode, subfolderCode, dateString) {
    try {
        if (!(await pathExists(directoryPath))) return null;
        const files = await fsp.readdir(directoryPath);
        const targetFileName = `${stationCode}_${subfolderCode}_${dateString}.csv`;
        
        if (files.includes(targetFileName)) {
            return path.join(directoryPath, targetFileName);
        }
        
        const matchingFiles = files.filter(file => 
            file.startsWith(`${stationCode}_${subfolderCode}_${dateString}_`) && 
            file.endsWith('.csv')
        );
        
        if (matchingFiles.length > 0) {
            return path.join(directoryPath, matchingFiles[0]);
        }
        
        return null;
    } catch (error) {
        return null;
    }
}

// Helper function to find all matching CSV files asynchronously
async function findAllCSVFiles(directoryPath, stationCode, subfolderCode, dateString) {
    try {
        if (!(await pathExists(directoryPath))) return [];
        const files = await fsp.readdir(directoryPath);
        const targetFileName = `${stationCode}_${subfolderCode}_${dateString}.csv`;
        
        const matchingFiles = files.filter(file => 
            (file === targetFileName || file.startsWith(`${stationCode}_${subfolderCode}_${dateString}_`)) && 
            file.endsWith('.csv')
        ).sort();
        
        return matchingFiles.map(file => path.join(directoryPath, file));
    } catch (error) {
        return [];
    }
}

// Raw file inspection endpoint
app.get('/api/station/:stationNumber/date/:dateTime/raw', async (req, res) => {
    try {
        const { stationNumber, dateTime } = req.params;
        
        const stationCode = STATION_MAPPING[parseInt(stationNumber)];
        if (!stationCode) {
            return res.status(400).json({
                error: 'Invalid station number',
                validStations: Object.keys(STATION_MAPPING).map(Number)
            });
        }
        
        let formattedDate;
        try {
            formattedDate = extractDate(decodeURIComponent(dateTime));
        } catch (error) {
            return res.status(400).json({
                error: error.message,
                example: '2025-05-09 05:51:39.803704'
            });
        }
        
        const subfolderCode = SUBFOLDER_MAPPING[stationCode];
        const dateFolderPath = path.join(
            BASE_PATH,
            stationCode,
            subfolderCode,
            formattedDate
        );
        
        const csvFilePath = await findCSVFile(dateFolderPath, stationCode, subfolderCode, formattedDate);
        
        if (!csvFilePath) {
            return res.status(404).json({
                error: 'CSV file not found'
            });
        }
        
        const rawContent = await fsp.readFile(csvFilePath, 'utf8');
        const lines = rawContent.split('\n').slice(0, 10);
        
        res.json({
            filePath: csvFilePath,
            totalLines: rawContent.split('\n').length,
            firstTenLines: lines,
            rawSample: rawContent.substring(0, 1000)
        });
        
    } catch (error) {
        console.error('Error inspecting raw file:', error);
        res.status(500).json({
            error: 'Internal server error',
            message: error.message
        });
    }
});

// API endpoint to get CSV data by station and date
app.get('/api/station/:stationNumber/date/:dateTime', async (req, res) => {
    try {
        const { stationNumber, dateTime } = req.params;
        
        const stationCode = STATION_MAPPING[parseInt(stationNumber)];
        if (!stationCode) {
            return res.status(400).json({
                error: 'Invalid station number',
                validStations: Object.keys(STATION_MAPPING).map(Number)
            });
        }
        
        let formattedDate;
        try {
            formattedDate = extractDate(decodeURIComponent(dateTime));
        } catch (error) {
            return res.status(400).json({
                error: error.message,
                example: '2025-05-09 05:51:39.803704'
            });
        }
        
        const subfolderCode = SUBFOLDER_MAPPING[stationCode];
        const dateFolderPath = path.join(
            BASE_PATH,
            stationCode,
            subfolderCode,
            formattedDate
        );
        
        if (!(await pathExists(dateFolderPath))) {
            return res.status(404).json({
                error: 'Date folder not found',
                path: dateFolderPath
            });
        }
        
        const csvFilePaths = await findAllCSVFiles(dateFolderPath, stationCode, subfolderCode, formattedDate);
        
        if (csvFilePaths.length === 0) {
            return res.status(404).json({
                error: 'CSV file not found',
                expectedPattern: `${stationCode}_${subfolderCode}_${formattedDate}.csv`,
                searchPath: dateFolderPath
            });
        }
        
        let combinedCsvData = [];
        for (const filePath of csvFilePaths) {
            const csvData = await readCSVFile(filePath);
            combinedCsvData = combinedCsvData.concat(csvData);
        }
        
        res.json({
            success: true,
            station: parseInt(stationNumber),
            stationCode: stationCode,
            date: formattedDate,
            filePath: csvFilePaths[0],
            filePaths: csvFilePaths,
            recordCount: combinedCsvData.length,
            data: combinedCsvData
        });
        
    } catch (error) {
        console.error('Error processing request:', error);
        res.status(500).json({
            error: 'Internal server error',
            message: error.message
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        basePath: BASE_PATH
    });
});

// List available stations
app.get('/api/stations', (req, res) => {
    res.json({
        stations: STATION_MAPPING,
        subfolders: SUBFOLDER_MAPPING
    });
});

// List available dates for a station
app.get('/api/station/:stationNumber/dates', async (req, res) => {
    try {
        const { stationNumber } = req.params;
        const stationCode = STATION_MAPPING[parseInt(stationNumber)];
        
        if (!stationCode) {
            return res.status(400).json({
                error: 'Invalid station number',
                validStations: Object.keys(STATION_MAPPING).map(Number)
            });
        }
        
        const subfolderCode = SUBFOLDER_MAPPING[stationCode];
        const stationPath = path.join(BASE_PATH, stationCode, subfolderCode);
        
        if (!(await pathExists(stationPath))) {
            return res.status(404).json({
                error: 'Station path not found',
                path: stationPath
            });
        }
        
        const entries = await fsp.readdir(stationPath, { withFileTypes: true });
        const dateFolders = entries
            .filter(e => e.isDirectory() && /^\d{8}$/.test(e.name))
            .map(e => e.name)
            .sort();
        
        res.json({
            station: parseInt(stationNumber),
            stationCode: stationCode,
            availableDates: dateFolders
        });
        
    } catch (error) {
        console.error('Error listing dates:', error);
        res.status(500).json({
            error: 'Internal server error',
            message: error.message
        });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({
        error: 'Something went wrong!',
        message: err.message
    });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`CSV Parser API running on port ${PORT}`);
    console.log(`Base path: ${BASE_PATH}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`Stations info: http://localhost:${PORT}/api/stations`);
    console.log(`Example usage: http://localhost:${PORT}/api/station/61/date/2025-05-28%2005:51:39.803704`);
});

module.exports = app; 