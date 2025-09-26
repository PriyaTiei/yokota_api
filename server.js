// const express = require('express');
// const fs = require('fs');
// const path = require('path');
// const csv = require('csv-parser');

// const app = express();
// const PORT = 8127;

// // Station number mapping
// const STATION_MAPPING = {
//     61: '0255',
//     60: '0240', 
//     58: '0250',
//     88: '0257',
//     89: '0230'
// };

// // Subfolder mapping for each station
// const SUBFOLDER_MAPPING = {
//     '0230': '120_0_100_97',
//     '0240': '120_0_100_99',
//     '0250': '120_0_100_98',
//     '0255': '120_0_100_96',
//     '0257': '120_0_100_78'
// };

// // Base mount path
// const BASE_PATH = '/mnt/yokota/AppData';

// app.use(express.json());

// // Helper function to extract date from datetime string
// function extractDate(dateTimeString) {
//     try {
//         // Extract date part from format like "2025-05-09 05:51:39.803704"
//         const datePart = dateTimeString.split(' ')[0];
//         // Convert "2025-05-09" to "20250509"
//         return datePart.replace(/-/g, '');
//     } catch (error) {
//         throw new Error('Invalid date format. Expected format: YYYY-MM-DD HH:MM:SS.ssssss');
//     }
// }

// // Helper function to read CSV file
// function readCSVFile(filePath) {
//     return new Promise((resolve, reject) => {
//         if (!fs.existsSync(filePath)) {
//             reject(new Error(`File not found: ${filePath}`));
//             return;
//         }

//         fs.readFile(filePath, 'utf8', (err, data) => {
//             if (err) {
//                 reject(err);
//                 return;
//             }
            
//             try {
//                 // Handle different line endings (Windows \r\n, Unix \n, old Mac \r)
//                 const normalizedData = data.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
//                 // Simply split by lines and filter out empty lines, then trim each line
//                 const lines = normalizedData.trim().split('\n')
//                     .map(line => line.trim())
//                     .filter(line => line.length > 0);
//                 resolve(lines);
//             } catch (error) {
//                 reject(error);
//             }
//         });
//     });
// }

// // Helper function to find the correct CSV file
// function findCSVFile(directoryPath, stationCode, subfolderCode, dateString) {
//     try {
//         const files = fs.readdirSync(directoryPath);
//         const targetFileName = `${stationCode}_${subfolderCode}_${dateString}.csv`;
        
//         // Look for exact match first
//         if (files.includes(targetFileName)) {
//             return path.join(directoryPath, targetFileName);
//         }
        
//         // If exact match not found, look for files with same prefix but with timestamp
//         const matchingFiles = files.filter(file => 
//             file.startsWith(`${stationCode}_${subfolderCode}_${dateString}_`) && 
//             file.endsWith('.csv')
//         );
        
//         if (matchingFiles.length > 0) {
//             // Return the first matching file (you might want to sort by timestamp if needed)
//             return path.join(directoryPath, matchingFiles[0]);
//         }
        
//         return null;
//     } catch (error) {
//         return null;
//     }
// }

// // Raw file inspection endpoint
// app.get('/api/station/:stationNumber/date/:dateTime/raw', async (req, res) => {
//     try {
//         const { stationNumber, dateTime } = req.params;
        
//         // Validate station number
//         const stationCode = STATION_MAPPING[parseInt(stationNumber)];
//         if (!stationCode) {
//             return res.status(400).json({
//                 error: 'Invalid station number',
//                 validStations: Object.keys(STATION_MAPPING).map(Number)
//             });
//         }
        
//         // Extract date from datetime string
//         let formattedDate;
//         try {
//             formattedDate = extractDate(decodeURIComponent(dateTime));
//         } catch (error) {
//             return res.status(400).json({
//                 error: error.message,
//                 example: '2025-05-09 05:51:39.803704'
//             });
//         }
        
//         // Get subfolder code
//         const subfolderCode = SUBFOLDER_MAPPING[stationCode];
        
//         // Construct file path
//         const dateFolderPath = path.join(
//             BASE_PATH,
//             stationCode,
//             subfolderCode,
//             formattedDate
//         );
        
//         // Find the correct CSV file
//         const csvFilePath = findCSVFile(dateFolderPath, stationCode, subfolderCode, formattedDate);
        
//         if (!csvFilePath) {
//             return res.status(404).json({
//                 error: 'CSV file not found'
//             });
//         }
        
//         // Read raw file content
//         const rawContent = fs.readFileSync(csvFilePath, 'utf8');
//         const lines = rawContent.split('\n').slice(0, 10); // First 10 lines
        
//         res.json({
//             filePath: csvFilePath,
//             totalLines: rawContent.split('\n').length,
//             firstTenLines: lines,
//             rawSample: rawContent.substring(0, 1000) // First 1000 characters
//         });
        
//     } catch (error) {
//         console.error('Error inspecting raw file:', error);
//         res.status(500).json({
//             error: 'Internal server error',
//             message: error.message
//         });
//     }
// });

// // API endpoint to get CSV data by station and date
// app.get('/api/station/:stationNumber/date/:dateTime', async (req, res) => {
//     try {
//         const { stationNumber, dateTime } = req.params;
        
//         // Validate station number
//         const stationCode = STATION_MAPPING[parseInt(stationNumber)];
//         if (!stationCode) {
//             return res.status(400).json({
//                 error: 'Invalid station number',
//                 validStations: Object.keys(STATION_MAPPING).map(Number)
//             });
//         }
        
//         // Extract date from datetime string
//         let formattedDate;
//         try {
//             formattedDate = extractDate(decodeURIComponent(dateTime));
//         } catch (error) {
//             return res.status(400).json({
//                 error: error.message,
//                 example: '2025-05-09 05:51:39.803704'
//             });
//         }
        
//         // Get subfolder code
//         const subfolderCode = SUBFOLDER_MAPPING[stationCode];
        
//         // Construct file path
//         const dateFolderPath = path.join(
//             BASE_PATH,
//             stationCode,
//             subfolderCode,
//             formattedDate
//         );
        
//         // Check if date folder exists
//         if (!fs.existsSync(dateFolderPath)) {
//             return res.status(404).json({
//                 error: 'Date folder not found',
//                 path: dateFolderPath
//             });
//         }
        
//         // Find the correct CSV file
//         const csvFilePath = findCSVFile(dateFolderPath, stationCode, subfolderCode, formattedDate);
        
//         if (!csvFilePath) {
//             return res.status(404).json({
//                 error: 'CSV file not found',
//                 expectedPattern: `${stationCode}_${subfolderCode}_${formattedDate}.csv`,
//                 searchPath: dateFolderPath
//             });
//         }
        
//         // Read and parse CSV file
//         const csvData = await readCSVFile(csvFilePath);
        
//         res.json({
//             success: true,
//             station: parseInt(stationNumber),
//             stationCode: stationCode,
//             date: formattedDate,
//             filePath: csvFilePath,
//             recordCount: csvData.length,
//             data: csvData
//         });
        
//     } catch (error) {
//         console.error('Error processing request:', error);
//         res.status(500).json({
//             error: 'Internal server error',
//             message: error.message
//         });
//     }
// });

// // Health check endpoint
// app.get('/health', (req, res) => {
//     res.json({ 
//         status: 'OK', 
//         timestamp: new Date().toISOString(),
//         basePath: BASE_PATH
//     });
// });

// // List available stations
// app.get('/api/stations', (req, res) => {
//     res.json({
//         stations: STATION_MAPPING,
//         subfolders: SUBFOLDER_MAPPING
//     });
// });

// // List available dates for a station
// app.get('/api/station/:stationNumber/dates', (req, res) => {
//     try {
//         const { stationNumber } = req.params;
//         const stationCode = STATION_MAPPING[parseInt(stationNumber)];
        
//         if (!stationCode) {
//             return res.status(400).json({
//                 error: 'Invalid station number',
//                 validStations: Object.keys(STATION_MAPPING).map(Number)
//             });
//         }
        
//         const subfolderCode = SUBFOLDER_MAPPING[stationCode];
//         const stationPath = path.join(BASE_PATH, stationCode, subfolderCode);
        
//         if (!fs.existsSync(stationPath)) {
//             return res.status(404).json({
//                 error: 'Station path not found',
//                 path: stationPath
//             });
//         }
        
//         const dateFolders = fs.readdirSync(stationPath)
//             .filter(folder => {
//                 const folderPath = path.join(stationPath, folder);
//                 return fs.statSync(folderPath).isDirectory() && /^\d{8}$/.test(folder);
//             })
//             .sort();
        
//         res.json({
//             station: parseInt(stationNumber),
//             stationCode: stationCode,
//             availableDates: dateFolders
//         });
        
//     } catch (error) {
//         console.error('Error listing dates:', error);
//         res.status(500).json({
//             error: 'Internal server error',
//             message: error.message
//         });
//     }
// });

// // Error handling middleware
// app.use((err, req, res, next) => {
//     console.error(err.stack);
//     res.status(500).json({
//         error: 'Something went wrong!',
//         message: err.message
//     });
// });

// // Start server
// app.listen(PORT, () => {
//     console.log(`CSV Parser API running on port ${PORT}`);
//     console.log(`Base path: ${BASE_PATH}`);
//     console.log(`Health check: http://localhost:${PORT}/health`);
//     console.log(`Stations info: http://localhost:${PORT}/api/stations`);
//     console.log(`Example usage: http://localhost:${PORT}/api/station/61/date/2025-05-28%2005:51:39.803704`);
// });

// module.exports = app;




const express = require('express');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

const app = express();
const PORT = 8127;

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
const BASE_PATH = '/mnt/yokota/AppData';

app.use(express.json());

// Helper function to extract date from datetime string
function extractDate(dateTimeString) {
    try {
        // Extract date part from format like "2025-05-09 05:51:39.803704"
        const datePart = dateTimeString.split(' ')[0];
        // Convert "2025-05-09" to "20250509"
        return datePart.replace(/-/g, '');
    } catch (error) {
        throw new Error('Invalid date format. Expected format: YYYY-MM-DD HH:MM:SS.ssssss');
    }
}

// Helper function to read CSV file
function readCSVFile(filePath) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(filePath)) {
            reject(new Error(`File not found: ${filePath}`));
            return;
        }

        fs.readFile(filePath, 'utf8', (err, data) => {
            if (err) {
                reject(err);
                return;
            }
            
            try {
                // Handle different line endings (Windows \r\n, Unix \n, old Mac \r)
                const normalizedData = data.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                // Simply split by lines and filter out empty lines, then trim each line
                const lines = normalizedData.trim().split('\n')
                    .map(line => line.trim())
                    .filter(line => line.length > 0);
                
                // Parse each line into structured data
                const parsedData = lines.map((line, index) => {
                    // Split by multiple spaces/tabs to get fields
                    const fields = line.split(/\s+/);
                    
                    if (fields.length >= 11) {
                        return {
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
                            timeDate: fields.slice(10).join(' ') || '' // Join remaining fields for date/time
                        };
                    } else {
                        // If line doesn't have expected number of fields, return raw data
                        return {
                            error: 'Unexpected format',
                            fieldCount: fields.length,
                            fields: fields
                        };
                    }
                });
                
                resolve(parsedData);
            } catch (error) {
                reject(error);
            }
        });
    });
}

// Helper function to find the correct CSV file
function findCSVFile(directoryPath, stationCode, subfolderCode, dateString) {
    try {
        const files = fs.readdirSync(directoryPath);
        const targetFileName = `${stationCode}_${subfolderCode}_${dateString}.csv`;
        
        // Look for exact match first
        if (files.includes(targetFileName)) {
            return path.join(directoryPath, targetFileName);
        }
        
        // If exact match not found, look for files with same prefix but with timestamp
        const matchingFiles = files.filter(file => 
            file.startsWith(`${stationCode}_${subfolderCode}_${dateString}_`) && 
            file.endsWith('.csv')
        );
        
        if (matchingFiles.length > 0) {
            // Return the first matching file (you might want to sort by timestamp if needed)
            return path.join(directoryPath, matchingFiles[0]);
        }
        
        return null;
    } catch (error) {
        return null;
    }
}

// Raw file inspection endpoint
app.get('/api/station/:stationNumber/date/:dateTime/raw', async (req, res) => {
    try {
        const { stationNumber, dateTime } = req.params;
        
        // Validate station number
        const stationCode = STATION_MAPPING[parseInt(stationNumber)];
        if (!stationCode) {
            return res.status(400).json({
                error: 'Invalid station number',
                validStations: Object.keys(STATION_MAPPING).map(Number)
            });
        }
        
        // Extract date from datetime string
        let formattedDate;
        try {
            formattedDate = extractDate(decodeURIComponent(dateTime));
        } catch (error) {
            return res.status(400).json({
                error: error.message,
                example: '2025-05-09 05:51:39.803704'
            });
        }
        
        // Get subfolder code
        const subfolderCode = SUBFOLDER_MAPPING[stationCode];
        
        // Construct file path
        const dateFolderPath = path.join(
            BASE_PATH,
            stationCode,
            subfolderCode,
            formattedDate
        );
        
        // Find the correct CSV file
        const csvFilePath = findCSVFile(dateFolderPath, stationCode, subfolderCode, formattedDate);
        
        if (!csvFilePath) {
            return res.status(404).json({
                error: 'CSV file not found'
            });
        }
        
        // Read raw file content
        const rawContent = fs.readFileSync(csvFilePath, 'utf8');
        const lines = rawContent.split('\n').slice(0, 10); // First 10 lines
        
        res.json({
            filePath: csvFilePath,
            totalLines: rawContent.split('\n').length,
            firstTenLines: lines,
            rawSample: rawContent.substring(0, 1000) // First 1000 characters
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
        
        // Validate station number
        const stationCode = STATION_MAPPING[parseInt(stationNumber)];
        if (!stationCode) {
            return res.status(400).json({
                error: 'Invalid station number',
                validStations: Object.keys(STATION_MAPPING).map(Number)
            });
        }
        
        // Extract date from datetime string
        let formattedDate;
        try {
            formattedDate = extractDate(decodeURIComponent(dateTime));
        } catch (error) {
            return res.status(400).json({
                error: error.message,
                example: '2025-05-09 05:51:39.803704'
            });
        }
        
        // Get subfolder code
        const subfolderCode = SUBFOLDER_MAPPING[stationCode];
        
        // Construct file path
        const dateFolderPath = path.join(
            BASE_PATH,
            stationCode,
            subfolderCode,
            formattedDate
        );
        
        // Check if date folder exists
        if (!fs.existsSync(dateFolderPath)) {
            return res.status(404).json({
                error: 'Date folder not found',
                path: dateFolderPath
            });
        }
        
        // Find the correct CSV file
        const csvFilePath = findCSVFile(dateFolderPath, stationCode, subfolderCode, formattedDate);
        
        if (!csvFilePath) {
            return res.status(404).json({
                error: 'CSV file not found',
                expectedPattern: `${stationCode}_${subfolderCode}_${formattedDate}.csv`,
                searchPath: dateFolderPath
            });
        }
        
        // Read and parse CSV file
        const csvData = await readCSVFile(csvFilePath);
        
        res.json({
            success: true,
            station: parseInt(stationNumber),
            stationCode: stationCode,
            date: formattedDate,
            filePath: csvFilePath,
            recordCount: csvData.length,
            data: csvData
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
app.get('/api/station/:stationNumber/dates', (req, res) => {
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
        
        if (!fs.existsSync(stationPath)) {
            return res.status(404).json({
                error: 'Station path not found',
                path: stationPath
            });
        }
        
        const dateFolders = fs.readdirSync(stationPath)
            .filter(folder => {
                const folderPath = path.join(stationPath, folder);
                return fs.statSync(folderPath).isDirectory() && /^\d{8}$/.test(folder);
            })
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
app.listen(PORT, () => {
    console.log(`CSV Parser API running on port ${PORT}`);
    console.log(`Base path: ${BASE_PATH}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`Stations info: http://localhost:${PORT}/api/stations`);
    console.log(`Example usage: http://localhost:${PORT}/api/station/61/date/2025-05-28%2005:51:39.803704`);
});

module.exports = app; 