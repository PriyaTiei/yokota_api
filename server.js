const express = require('express');
require('dotenv').config();
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const readline = require('readline');

const app = express();
const PORT = process.env.PORT || 8127;

// Default Station to Folder ID mappings based on production controller status sheet
const DEFAULT_STATION_MAPPING = {
    '61': ['0255', '0102'], // EGR Pipe (255) & I/M Bracket Bolt (102)
    '60': ['0240'],         // EGR Valve (240)
    '59': ['0053'],         // EGR Cooler Bolt & Nut (53)
    '58': ['0250'],         // Intake Manifold (250)
    '53': ['0103'],         // Ignition Coil Bolt (103)
    '45': ['0104'],         // Throttle Body Bolt (104)
    '43': ['0230'],         // Water Inlet Housing (230)
    '21': ['0230'],         // Water Inlet Housing (230)
    '20': ['0257'],         // VVT Bolt Tightening (257)
    '17': ['0039'],         // Water Bypass Outlet Bolt (39)
    'Cam housing sub assy': ['0257'],
    'CHS': ['0257']
};

// Known default controller IP subfolders
const DEFAULT_SUBFOLDER_MAPPING = {
    '0039': '120_0_100_95',
    '0053': '120_0_100_94',
    '0102': '120_0_100_93',
    '0103': '120_0_100_92',
    '0104': '120_0_100_91',
    '0230': '120_0_100_97',
    '0240': '120_0_100_99',
    '0250': '120_0_100_98',
    '0255': '120_0_100_96',
    '0257': '120_0_100_78'
};

app.use(express.json());

async function pathExists(p) {
    try {
        await fsp.access(p, fs.constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

// In-Memory dynamic cache for discovered data paths (5-minute TTL)
let cachedBaseDataPaths = null;
let lastPathsDiscoveryTime = 0;
const PATHS_DISCOVERY_TTL_MS = 5 * 60 * 1000;

// Base data paths configuration (supports single path, comma-separated list, or dynamic subfolder discovery)
async function getBaseDataPaths() {
    const now = Date.now();
    if (cachedBaseDataPaths && (now - lastPathsDiscoveryTime < PATHS_DISCOVERY_TTL_MS)) {
        return cachedBaseDataPaths;
    }

    const rawPaths = (process.env.YOKOTA_DATA_PATH || process.env.BASE_PATH || '/mnt/yokota/AppData')
        .split(',')
        .map(p => p.trim())
        .filter(Boolean);

    const discoveredPaths = [];

    for (const rootPath of rawPaths) {
        // 1. Include root directory directly
        discoveredPaths.push(rootPath);

        // 2. Discover subdirectories (e.g. DATA-*, Backup, Live, AppData, etc.)
        try {
            if (await pathExists(rootPath)) {
                const entries = await fsp.readdir(rootPath, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('$')) {
                        discoveredPaths.push(path.join(rootPath, entry.name));
                    }
                }
            }
        } catch (err) {
            console.warn(`Warning: Could not scan root path ${rootPath}:`, err.message);
        }
    }

    cachedBaseDataPaths = [...new Set(discoveredPaths)];
    lastPathsDiscoveryTime = now;
    return cachedBaseDataPaths;
}

// In-Memory MTime Cache to avoid repeated disk reads & string splits
const yokotaFileCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_ENTRIES = 300;

// Fast Yokota timestamp parser with year resolution
function parseFastYokotaTimestamp(timeDateStr, referenceYear) {
    if (!timeDateStr || typeof timeDateStr !== 'string') return null;
    const cleanStr = timeDateStr.trim();

    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(cleanStr)) {
        const iso = cleanStr.replace(/\//g, '-');
        const ms = Date.parse(iso);
        if (!isNaN(ms)) return ms;
    }

    const parts = cleanStr.split(' ');
    if (parts.length >= 2) {
        const md = parts[0].split('/');
        if (md.length === 2) {
            const month = md[0].padStart(2, '0');
            const day = md[1].padStart(2, '0');
            const year = referenceYear || new Date().getFullYear();
            const ms = Date.parse(`${year}-${month}-${day}T${parts[1]}`);
            if (!isNaN(ms)) return ms;
        }
    }

    const fallback = Date.parse(cleanStr);
    return isNaN(fallback) ? null : fallback;
}

// Helper function to extract date string (YYYYMMDD) from any date/datetime representation
function extractDate(dateTimeString) {
    if (!dateTimeString) {
        throw new Error('Date parameter is required');
    }
    try {
        const cleanStr = String(dateTimeString).trim();
        if (/^\d{8}$/.test(cleanStr)) {
            return cleanStr;
        }
        const datePart = cleanStr.split(/[ T]/)[0];
        const normalized = datePart.replace(/[-/]/g, '');
        if (/^\d{8}$/.test(normalized)) {
            return normalized;
        }
        const parsed = new Date(cleanStr);
        if (!isNaN(parsed.getTime())) {
            const y = parsed.getFullYear();
            const m = String(parsed.getMonth() + 1).padStart(2, '0');
            const d = String(parsed.getDate()).padStart(2, '0');
            return `${y}${m}${d}`;
        }
        return normalized;
    } catch (error) {
        throw new Error('Invalid date format. Expected format: YYYY-MM-DD or YYYYMMDD or YYYY-MM-DD HH:MM:SS');
    }
}

// Helper to resolve station codes and folder IDs dynamically
async function resolveStationDetails(station, folder) {
    let stationCodes = [];

    if (folder) {
        const rawFolders = Array.isArray(folder) ? folder : folder.toString().split(',');
        for (const f of rawFolders) {
            const clean = f.trim();
            if (clean) {
                stationCodes.push(clean);
                if (/^\d+$/.test(clean)) {
                    stationCodes.push(clean.padStart(4, '0'));
                    stationCodes.push(clean.replace(/^0+/, ''));
                }
            }
        }
    } else if (station != null) {
        const stnKey = station.toString().trim();
        const mapped = DEFAULT_STATION_MAPPING[stnKey] || DEFAULT_STATION_MAPPING[parseInt(stnKey)];
        
        if (mapped) {
            const list = Array.isArray(mapped) ? mapped : [mapped];
            list.forEach(c => {
                stationCodes.push(c);
                if (/^\d+$/.test(c)) {
                    stationCodes.push(c.padStart(4, '0'));
                    stationCodes.push(c.replace(/^0+/, ''));
                }
            });
        } else if (/^\d+$/.test(stnKey)) {
            stationCodes.push(stnKey);
            stationCodes.push(stnKey.padStart(4, '0'));
            stationCodes.push(stnKey.replace(/^0+/, ''));
        } else {
            stationCodes.push(stnKey);
        }
    }

    return {
        stationCodes: [...new Set(stationCodes.filter(Boolean))]
    };
}

// Helper function to read CSV file using streaming readline with mtime cache & optional window filter
async function readCSVFile(filePath, filterWindow) {
    const stats = await fsp.stat(filePath);
    const cacheKey = filterWindow 
        ? `${filePath}_${filterWindow.safeStartMs}_${filterWindow.safeEndMs}` 
        : filePath;
    const cached = yokotaFileCache.get(cacheKey);

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

            // Stream-level window filtering: skip object allocation for lines outside window
            if (filterWindow) {
                const spaceIdx = trimmed.lastIndexOf(' ');
                if (spaceIdx > 0) {
                    const secondLastSpace = trimmed.lastIndexOf(' ', spaceIdx - 1);
                    const timeDateSlice = trimmed.slice(secondLastSpace !== -1 ? secondLastSpace + 1 : spaceIdx + 1);
                    const rowMs = parseFastYokotaTimestamp(timeDateSlice, filterWindow.arrivalYear);
                    if (rowMs !== null) {
                        if (rowMs < filterWindow.safeStartMs || rowMs > filterWindow.safeEndMs) {
                            return; // Skip line immediately without creating JS object
                        }
                    }
                }
            }

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
            } else if (fields.length > 0) {
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

    yokotaFileCache.set(cacheKey, {
        mtimeMs: stats.mtimeMs,
        cachedAt: Date.now(),
        data: parsedData
    });

    return parsedData;
}

// Helper function to find all matching CSV files asynchronously across base paths
async function findAllMatchingCSVFiles(baseDataPaths, stationCodes, dateString) {
    const matchedFiles = [];

    for (const rootPath of baseDataPaths) {
        if (!(await pathExists(rootPath))) continue;

        for (const stnCode of stationCodes) {
            const targetStationDirs = [];

            // 1. Direct check: <rootPath>/<stnCode>
            const directStationPath = path.join(rootPath, stnCode);
            if (await pathExists(directStationPath)) {
                targetStationDirs.push(directStationPath);
            }

            // 2. Also check one level of subdirectories under rootPath
            try {
                const subEntries = await fsp.readdir(rootPath, { withFileTypes: true });
                for (const sub of subEntries) {
                    if (sub.isDirectory() && !sub.name.startsWith('.') && !sub.name.startsWith('$')) {
                        const directSub = path.join(rootPath, sub.name, stnCode);
                        if (await pathExists(directSub)) {
                            targetStationDirs.push(directSub);
                        }
                    }
                }
            } catch {
                // Ignore readdir error
            }

            for (const stnDir of [...new Set(targetStationDirs)]) {
                let subdirsToSearch = [];
                try {
                    const stnEntries = await fsp.readdir(stnDir, { withFileTypes: true });
                    subdirsToSearch = stnEntries.filter(e => e.isDirectory()).map(e => e.name);
                } catch {
                    subdirsToSearch = [];
                }

                for (const subCode of subdirsToSearch) {
                    const dateFolderPath = path.join(stnDir, subCode, dateString);
                    if (await pathExists(dateFolderPath)) {
                        try {
                            const files = await fsp.readdir(dateFolderPath);
                            const csvFiles = files.filter(file => 
                                file.endsWith('.csv') &&
                                (file.includes(dateString) || file.startsWith(`${stnCode}_${subCode}`))
                            ).sort();

                            for (const csvFile of csvFiles) {
                                matchedFiles.push(path.join(dateFolderPath, csvFile));
                            }
                        } catch {
                            // Ignore file list errors
                        }
                    }
                }
            }
        }
    }

    return [...new Set(matchedFiles)];
}

// Health check endpoint (Returns discovered base paths)
app.get('/health', async (req, res) => {
    try {
        const basePaths = await getBaseDataPaths();
        res.json({
            status: 'OK',
            timestamp: new Date().toISOString(),
            basePaths: basePaths,
            configuredStations: Object.keys(DEFAULT_STATION_MAPPING)
        });
    } catch (error) {
        res.status(500).json({
            status: 'ERROR',
            error: error.message
        });
    }
});

// List configured stations and subfolder mappings
app.get('/api/stations', (req, res) => {
    res.json({
        stations: DEFAULT_STATION_MAPPING,
        subfolders: DEFAULT_SUBFOLDER_MAPPING
    });
});

// List available dates for a station across all discovered base paths
async function getStationDatesHandler(req, res) {
    try {
        const station = req.params.stationNumber || req.query.station;
        const folder = req.query.folder;

        if (!station && !folder) {
            return res.status(400).json({
                error: 'Missing required parameter: station or folder'
            });
        }

        const { stationCodes } = await resolveStationDetails(station, folder);
        if (stationCodes.length === 0) {
            return res.status(400).json({
                error: 'Invalid station or folder provided',
                validStations: Object.keys(DEFAULT_STATION_MAPPING)
            });
        }

        const baseDataPaths = await getBaseDataPaths();
        let allDates = [];
        let foundStation = false;

        for (const rootPath of baseDataPaths) {
            if (!(await pathExists(rootPath))) continue;

            for (const stnCode of stationCodes) {
                const stnDir = path.join(rootPath, stnCode);
                if (!(await pathExists(stnDir))) continue;

                foundStation = true;
                let subdirs = [];
                try {
                    const entries = await fsp.readdir(stnDir, { withFileTypes: true });
                    subdirs = entries.filter(e => e.isDirectory()).map(e => e.name);
                } catch {
                    subdirs = [];
                }

                for (const sub of subdirs) {
                    const subPath = path.join(stnDir, sub);
                    if (!(await pathExists(subPath))) continue;

                    try {
                        const entries = await fsp.readdir(subPath, { withFileTypes: true });
                        const dateFolders = entries
                            .filter(e => e.isDirectory() && /^\d{8}$/.test(e.name))
                            .map(e => e.name);
                        allDates = allDates.concat(dateFolders);
                    } catch {
                        // Ignore readdir error
                    }
                }
            }
        }

        if (!foundStation && allDates.length === 0) {
            return res.status(404).json({
                error: `No folders found for station ${station}`,
                searchedCodes: stationCodes
            });
        }

        allDates = [...new Set(allDates)].sort();

        res.json({
            station: station || undefined,
            resolvedCodes: stationCodes,
            availableDates: allDates
        });

    } catch (error) {
        console.error('Error listing dates:', error);
        res.status(500).json({
            error: 'Internal server error',
            message: error.message
        });
    }
}

app.get('/api/station/:stationNumber/dates', getStationDatesHandler);
app.get('/api/dates', getStationDatesHandler);

// Raw file inspection endpoint
app.get('/api/station/:stationNumber/date/:dateTime/raw', async (req, res) => {
    try {
        const { stationNumber, dateTime } = req.params;
        const { folder } = req.query;

        const { stationCodes } = await resolveStationDetails(stationNumber, folder);
        if (stationCodes.length === 0) {
            return res.status(400).json({
                error: 'Invalid station number',
                validStations: Object.keys(DEFAULT_STATION_MAPPING)
            });
        }

        let formattedDate;
        try {
            formattedDate = extractDate(decodeURIComponent(dateTime));
        } catch (error) {
            return res.status(400).json({
                error: error.message,
                example: '2025-05-09 05:51:39.803704 or 20250509'
            });
        }

        const baseDataPaths = await getBaseDataPaths();
        const csvFilePaths = await findAllMatchingCSVFiles(baseDataPaths, stationCodes, formattedDate);

        if (csvFilePaths.length === 0) {
            return res.status(404).json({
                error: 'CSV file not found',
                stationCodes,
                date: formattedDate
            });
        }

        const targetFile = csvFilePaths[0];
        const rawContent = await fsp.readFile(targetFile, 'utf8');
        const lines = rawContent.split('\n').slice(0, 10);

        res.json({
            filePath: targetFile,
            allMatchingFiles: csvFilePaths,
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

// Core data retrieval handler
async function getStationDataHandler(req, res) {
    try {
        const station = req.params.stationNumber || req.query.station;
        const dateTime = req.params.dateTime || req.query.date || req.query.dateTime;
        const { folder, time, startTime, nextTime, endTime } = req.query;

        if (!station && !folder) {
            return res.status(400).json({
                error: 'Missing required parameter: station or folder'
            });
        }

        if (!dateTime) {
            return res.status(400).json({
                error: 'Missing required parameter: date or dateTime'
            });
        }

        const { stationCodes } = await resolveStationDetails(station, folder);
        if (stationCodes.length === 0) {
            return res.status(400).json({
                error: 'Invalid station number',
                validStations: Object.keys(DEFAULT_STATION_MAPPING)
            });
        }

        let formattedDate;
        try {
            formattedDate = extractDate(decodeURIComponent(dateTime));
        } catch (error) {
            return res.status(400).json({
                error: error.message,
                example: '2025-05-09 05:51:39.803704 or 20250509'
            });
        }

        // Compute safe stream filter window if startTime is provided (±5 minute safety buffer)
        let filterWindow = null;
        if (startTime) {
            const startMs = new Date(decodeURIComponent(startTime)).getTime();
            if (!isNaN(startMs)) {
                const endTargetMs = (nextTime || endTime) 
                    ? new Date(decodeURIComponent(nextTime || endTime)).getTime() 
                    : (startMs + 150 * 1000);
                const endMs = isNaN(endTargetMs) ? (startMs + 150 * 1000) : endTargetMs;
                filterWindow = {
                    safeStartMs: startMs - 5 * 60 * 1000,
                    safeEndMs: endMs + 5 * 60 * 1000,
                    arrivalYear: new Date(startMs).getFullYear()
                };
            }
        }

        const baseDataPaths = await getBaseDataPaths();
        const csvFilePaths = await findAllMatchingCSVFiles(baseDataPaths, stationCodes, formattedDate);

        if (csvFilePaths.length === 0) {
            return res.status(404).json({
                error: 'CSV file not found',
                searchedCodes: stationCodes,
                date: formattedDate,
                searchedPaths: baseDataPaths
            });
        }

        let combinedCsvData = [];
        for (const filePath of csvFilePaths) {
            const csvData = await readCSVFile(filePath, filterWindow);
            
            if (time) {
                const timeFiltered = csvData.filter(row => row.timeDate && row.timeDate.includes(time));
                combinedCsvData = combinedCsvData.concat(timeFiltered);
            } else {
                combinedCsvData = combinedCsvData.concat(csvData);
            }
        }

        if (combinedCsvData.length === 0) {
            return res.status(404).json({
                error: `No records found for station ${station} on date ${formattedDate}${time ? ` at time ${time}` : ''}`
            });
        }

        res.json({
            success: true,
            station: station || undefined,
            resolvedCodes: stationCodes,
            date: formattedDate,
            timeFilter: time || undefined,
            filePaths: csvFilePaths,
            recordCount: combinedCsvData.length,
            data: combinedCsvData
        });

    } catch (error) {
        console.error('Error processing data request:', error);
        res.status(500).json({
            error: 'Internal server error',
            message: error.message
        });
    }
}

app.get('/api/station/:stationNumber/date/:dateTime', getStationDataHandler);
app.get('/api/yokota-data', getStationDataHandler);

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({
        error: 'Something went wrong!',
        message: err.message
    });
});

// Start server
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Yokota CSV Parser API running on port ${PORT}`);
    const initialPaths = await getBaseDataPaths();
    console.log(`Base data paths configured: ${JSON.stringify(initialPaths)}`);
    console.log(`Station mappings configured: ${JSON.stringify(DEFAULT_STATION_MAPPING)}`);
});

module.exports = app;