const express = require('express');
require('dotenv').config();
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const readline = require('readline');

const app = express();
const PORT = process.env.PORT || 8127;

// Station → controller folder mapping (4-digit padded folder IDs)
// These are the directory names directly under /mnt/yokota/AppData/
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
    'Cam housing': ['0257'],
    'CAM_HOUSING': ['0257'],
    'CHS': ['0257']
};

// Controller folder → IP-based subfolder FAST-PATH hints.
//
// IMPORTANT: The actual on-disk subfolder name is built from the controller's OWN numeric ID,
// not from a separate IP address tail.  The real layout under /mnt/yokota/AppData/ is:
//
//   <4-digit-folder>/120_0_100_<stripped-numeric>/<date>/<file>.csv
//
// e.g.  0053 → 0053/120_0_100_53/20260819/0053_120_0_100_53_20260819.csv
//        0039 → 0039/120_0_100_39/20260819/0039_120_0_100_39_20260819.csv
//
// If the hinted subfolder does not exist the code falls back to scanning the controller
// directory for any subdirectory that contains the requested date folder.
// Keys are 4-digit padded folder IDs.
const DEFAULT_SUBFOLDER_MAPPING = {
    '0039': '120_0_100_39',
    '0053': '120_0_100_53',
    '0102': '120_0_100_102',
    '0103': '120_0_100_103',
    '0104': '120_0_100_104',
    '0230': '120_0_100_230',
    '0240': '120_0_100_240',
    '0250': '120_0_100_250',
    '0255': '120_0_100_255',
    '0257': '120_0_100_257'
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
        const ms = new Date(iso).getTime();
        if (!isNaN(ms)) return ms;
    }

    const parts = cleanStr.split(/\s+/);
    if (parts.length >= 2) {
        const md = parts[0].split(/[-/]/);
        if (md.length === 2) {
            const month = md[0].padStart(2, '0');
            const day = md[1].padStart(2, '0');
            const year = referenceYear || new Date().getFullYear();
            const ms = new Date(`${year}-${month}-${day} ${parts[1]}`).getTime();
            if (!isNaN(ms)) return ms;
        }
    }

    const fallback = new Date(cleanStr).getTime();
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
        let mapped = DEFAULT_STATION_MAPPING[stnKey] || DEFAULT_STATION_MAPPING[parseInt(stnKey, 10)];
        
        if (!mapped) {
            const norm = stnKey.toLowerCase().replace(/[\s_-]+/g, '');
            for (const [k, v] of Object.entries(DEFAULT_STATION_MAPPING)) {
                if (k.toLowerCase().replace(/[\s_-]+/g, '') === norm) {
                    mapped = v;
                    break;
                }
            }
        }

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

// In-Memory dynamic cache for discovered CSV file paths (5-minute TTL)
const foundFilesCache = new Map();
const FILES_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Parse a single Yokota CSV data line into a structured record.
 *
 * Line format (space-separated, 13 fields):
 *   field 0  : controllerId   e.g. "i0053"  — raw device-emitted controller identity
 *   field 1  : folder         e.g. "1a"     — internal spindle / head number
 *   field 2  : program        e.g. "657-"
 *   field 3  : unknownValue1  e.g. "5A"
 *   field 4  : torqueDuplicate e.g. "27.9K"
 *   field 5  : unknownValue2  e.g. "4385"
 *   field 6  : unknownValue3  e.g. "17"
 *   field 7  : unknownValue4  e.g. "96"
 *   field 8  : unknownValue5  e.g. "32"
 *   field 9  : torque         e.g. "8"
 *   field 10 : judgement      e.g. "Aok"
 *   field 11 : date           e.g. "08/19"
 *   field 12 : time           e.g. "08:45:17"
 *
 * CRITICAL: "folder" in the response is fields[1] (the internal spindle ID like "1a"),
 * NOT fields[0] (the controller ID like "i0053").  Controller identity comes from the
 * file path / directory name.
 */
function parseYokotaLine(trimmed) {
    // Skip angle-curve data, graph headers, summary comments
    if (
        trimmed.startsWith('@') ||
        trimmed.startsWith('FreeRun:') ||
        trimmed.startsWith('Final:') ||
        trimmed.startsWith('Trq,') ||
        /^[-\d.,]+$/.test(trimmed)
    ) {
        return null;
    }

    const fields = trimmed.split(/\s+/);

    // Need at least 13 fields (indices 0–12)
    if (fields.length < 13) {
        return null;
    }

    const controllerId    = fields[0];  // e.g. "i0053"  — controller identity
    const folder          = fields[1];  // e.g. "1a"     — internal spindle/head number
    const program         = fields[2];
    const unknownValue1   = fields[3];
    const torqueDuplicate = fields[4];
    const unknownValue2   = fields[5];
    const unknownValue3   = fields[6];
    const unknownValue4   = fields[7];
    const unknownValue5   = fields[8];
    const torque          = fields[9];
    const judgement       = fields[10];
    const timeDate        = `${fields[11]} ${fields[12]}`;

    if (!controllerId || !folder || !timeDate || !torque) {
        return null;
    }

    return {
        controllerId,   // "i0053"
        folder,         // "1a"
        program,
        unknownValue1,
        torqueDuplicate,
        unknownValue2,
        unknownValue3,
        unknownValue4,
        unknownValue5,
        torque,
        judgement,
        timeDate
    };
}

// Helper function to read and parse CSV file with fast in-memory caching and zero-allocation filtering
async function readCSVFile(filePath, filterWindow) {
    const stats = await fsp.stat(filePath);
    const cached = yokotaFileCache.get(filePath);

    let allRecords;
    if (cached && cached.mtimeMs === stats.mtimeMs && (Date.now() - cached.cachedAt < CACHE_TTL_MS)) {
        allRecords = cached.data;
    } else {
        allRecords = await new Promise((resolve, reject) => {
            const results = [];
            const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
            const rl = readline.createInterface({
                input: fileStream,
                crlfDelay: Infinity
            });

            rl.on('line', (line) => {
                const trimmed = line.trim();
                if (!trimmed) return;

                const record = parseYokotaLine(trimmed);
                if (record) {
                    results.push(record);
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
            data: allRecords
        });
    }

    // In-memory instant window filtering (< 0.1ms)
    if (filterWindow && Array.isArray(allRecords)) {
        return allRecords.filter(item => {
            const rowMs = parseFastYokotaTimestamp(item.timeDate, filterWindow.arrivalYear);
            if (rowMs !== null) {
                return rowMs >= filterWindow.safeStartMs && rowMs <= filterWindow.safeEndMs;
            }
            return true;
        });
    }

    return allRecords;
}

// Helper function to find all matching CSV files asynchronously across base paths with ultra-fast direct lookup
async function findAllMatchingCSVFiles(baseDataPaths, stationCodes, dateString) {
    const cacheKey = `${stationCodes.join(',')}_${dateString}`;
    const cached = foundFilesCache.get(cacheKey);
    if (cached && (Date.now() - cached.cachedAt < FILES_CACHE_TTL_MS)) {
        return cached.files;
    }

    const matchedFiles = [];

    for (const rootPath of baseDataPaths) {
        if (!(await pathExists(rootPath))) continue;

        for (const stnCode of stationCodes) {
            // Always use 4-digit padded form as the directory name under /mnt/yokota/AppData/
            // e.g. "53" → "0053", "0053" stays "0053"
            const code4 = /^\d+$/.test(stnCode) ? stnCode.padStart(4, '0') : stnCode;

            let foundForThisCode = false;

            // FAST PATH 1: Direct subfolder lookup from known mapping (0ms disk scan)
            // Key into DEFAULT_SUBFOLDER_MAPPING is always the 4-digit padded form.
            const knownSub = DEFAULT_SUBFOLDER_MAPPING[code4];
            if (knownSub) {
                const directDatePath = path.join(rootPath, code4, knownSub, dateString);
                if (await pathExists(directDatePath)) {
                    try {
                        const files = await fsp.readdir(directDatePath);
                        const csvFiles = files.filter(f => f.endsWith('.csv')).sort();
                        for (const f of csvFiles) {
                            matchedFiles.push(path.join(directDatePath, f));
                        }
                        if (csvFiles.length > 0) {
                            foundForThisCode = true;
                        }
                    } catch { /* ignore */ }
                }
            }

            // FAST PATH 2: Scan the controller folder for any IP-based subdirectory
            // (used when the hint is wrong or the mapping is missing)
            if (!foundForThisCode) {
                const controllerDir = path.join(rootPath, code4);
                if (await pathExists(controllerDir)) {
                    try {
                        const stnEntries = await fsp.readdir(controllerDir, { withFileTypes: true });
                        for (const sub of stnEntries) {
                            if (sub.isDirectory()) {
                                const datePath = path.join(controllerDir, sub.name, dateString);
                                if (await pathExists(datePath)) {
                                    const files = await fsp.readdir(datePath);
                                    const csvFiles = files.filter(f => f.endsWith('.csv')).sort();
                                    for (const f of csvFiles) {
                                        matchedFiles.push(path.join(datePath, f));
                                    }
                                }
                            }
                        }
                    } catch { /* ignore */ }
                }
            }
        }
    }

    const uniqueFiles = [...new Set(matchedFiles)];
    if (uniqueFiles.length > 0) {
        foundFilesCache.set(cacheKey, {
            cachedAt: Date.now(),
            files: uniqueFiles
        });
    }

    return uniqueFiles;
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

        console.log(`[Yokota API Handler] Station: ${station || '(folder only)'} | Date: ${formattedDate} | Start: ${startTime || 'none'} | Next: ${nextTime || 'none'}`);

        // Compute safe stream filter window if startTime is provided (±30 minute safety buffer)
        let filterWindow = null;
        if (startTime) {
            const startClean = decodeURIComponent(startTime).replace('T', ' ').replace('Z', '');
            const startMs = new Date(startClean).getTime();
            if (!isNaN(startMs)) {
                let endMs = startMs + 300 * 1000;
                if (nextTime || endTime) {
                    const endClean = decodeURIComponent(nextTime || endTime).replace('T', ' ').replace('Z', '');
                    const endParsed = new Date(endClean).getTime();
                    if (!isNaN(endParsed)) {
                        endMs = endParsed;
                    }
                }
                filterWindow = {
                    safeStartMs: startMs - 30 * 60 * 1000, // 30-minute safety buffer
                    safeEndMs: endMs + 30 * 60 * 1000,     // 30-minute safety buffer
                    arrivalYear: new Date(startMs).getFullYear()
                };
            }
        }

        const baseDataPaths = await getBaseDataPaths();
        const csvFilePaths = await findAllMatchingCSVFiles(baseDataPaths, stationCodes, formattedDate);

        if (csvFilePaths.length === 0) {
            console.log(`[Yokota API Handler] CSV file not found for station ${station} on date ${formattedDate}`);
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

        console.log(`[Yokota API Handler] Returning ${combinedCsvData.length} records for Station ${station} on Date ${formattedDate}`);

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