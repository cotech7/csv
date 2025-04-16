const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const xls = require('xlsjs');
const xlsx = require('xlsx');
const pdf = require('pdf-parse');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const os = require('os'); // For temporary directory
require('dotenv').config();

const app = express();

// Use temporary directory for file uploads
const tempDir = os.tmpdir(); // e.g., /tmp on Vercel

// Set storage for uploaded files using temporary directory
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, tempDir);
  },
  filename: (req, file, cb) => {
    // Use a unique filename to avoid conflicts
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `indus-${uniqueSuffix}.csv`);
  },
});

// Initialize multer upload with file type validation
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.csv', '.xls', '.xlsx', '.pdf'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV, XLS, XLSX and PDF files are supported'));
    }
  },
});

// Set EJS as the template engine
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Render the index page
app.get('/', (req, res) => {
  res.render('index', { message: null, error: null });
});

// Set up a route for file upload
app.post('/upload', upload.single('csvFile'), async (req, res) => {
  let filePath;
  try {
    if (!req.file) {
      return res.status(400).render('index', {
        message: null,
        error: 'No file uploaded.',
      });
    }

    filePath = req.file.path; // Use the path assigned by multer
    const results = [];

    if (req.file.originalname.endsWith('.csv')) {
      await new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
          .pipe(csv())
          .on('data', (row) => {
            const creditAmount =
              row['Credit'] ||
              row['Credit '] ||
              row['Amount'] ||
              row['Amount (INR)'];
            let utrNumber =
              row['Cheque No.'] ||
              row[' Description'] ||
              row['Description'] ||
              row['UTR'] ||
              row['Utr'];

            utrNumber = extractUTRNumber(utrNumber);

            let extractedCreditAmount =
              creditAmount && creditAmount.includes(',')
                ? parseFloat(creditAmount.replace(/,/g, ''))
                : parseFloat(creditAmount);
            extractedCreditAmount = !isNaN(extractedCreditAmount)
              ? extractedCreditAmount
              : null;

            if (utrNumber !== null && extractedCreditAmount !== null) {
              results.push({
                UTR_Number: utrNumber,
                Credit_Amount: extractedCreditAmount,
              });
            }
          })
          .on('end', resolve)
          .on('error', reject);
      });
    } else if (req.file.originalname.endsWith('.xls')) {
      const workbook = xls.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const jsonData = xls.utils.sheet_to_json(worksheet, { header: 1 });

      const headersRow = findHeadersRow(jsonData);
      if (headersRow === null) {
        throw new Error('Headers not found in XLS file.');
      }

      const headers = jsonData[headersRow];
      const data = jsonData.slice(headersRow + 1);

      data.forEach((row) => {
        const obj = {};
        headers.forEach((header, index) => {
          const cellValue =
            row[index] !== undefined ? row[index].toString() : ''; // Ensure it's a string

          if (header === 'Description') {
            const utrNumber = cellValue.match(/\b[A-Za-z]?(\d{12})\b/);
            obj['UTR_Number'] = utrNumber ? utrNumber[0] : null;
          } else if (header === 'Amount (INR)' || header === 'Txn Amount') {
            const creditAmount = parseFloat(
              cellValue.replace(/[₹,Cr]/g, '').trim()
            ); // Remove ₹, commas, and 'Cr'
            obj['Credit_Amount'] = isNaN(creditAmount) ? null : creditAmount;
          }
        });

        if (obj['UTR_Number'] && obj['Credit_Amount'] !== null) {
          results.push(obj);
        }
      });
    } else if (req.file.originalname.endsWith('.xlsx')) {
      const workbook = xlsx.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const jsonData = xlsx.utils.sheet_to_json(worksheet, { header: 1 });

      // Function to process a sheet
      const processSheet = (jsonData, headersRow = null) => {
        if (headersRow === null) {
          headersRow = findHeadersRow(jsonData);
        }
        if (headersRow === null) {
          throw new Error('Headers not found in XLSX file.');
        }

        const headers = jsonData[headersRow];
        const data = jsonData.slice(headersRow + 1);

        data.forEach((row) => {
          const obj = {};
          headers.forEach((header, index) => {
            const cellValue =
              row[index] !== undefined ? row[index].toString() : ''; // Ensure it's a string

            if (header === 'Description') {
              const utrNumber = cellValue.match(/\b[A-Za-z]?(\d{12})\b/);
              obj['UTR_Number'] = utrNumber ? utrNumber[0] : null;
            } else if (
              header === 'Amount' ||
              header === 'RefNo                         Txn Amount' ||
              header ===
                'Value Date                        RefNo                         Txn Amount (DD/MM/YYYY)'
            ) {
              const creditAmount = parseFloat(
                cellValue.replace(/[₹,Cr]/g, '').trim()
              ); // Remove ₹, commas, and 'Cr'
              obj['Credit_Amount'] = isNaN(creditAmount) ? null : creditAmount;
            }
          });

          if (obj['UTR_Number'] && obj['Credit_Amount'] !== null) {
            results.push(obj);
          }
        });
      };

      // Process main sheet
      processSheet(jsonData);

      // Process additional tables (Table 2, Table 3, etc.)
      workbook.SheetNames.forEach((sheet) => {
        if (/^Table \d+$/.test(sheet)) {
          const tableSheet = workbook.Sheets[sheet];
          const tableData = xlsx.utils.sheet_to_json(tableSheet, { header: 1 });

          tableData.forEach((row, rowIndex) => {
            if (rowIndex >= 1) {
              // Start from row 2 (B2 & D2)
              const cellValue = row[1] ? row[1].toString() : ''; // Column B (Index 1)

              const utrNumber = cellValue.match(/\b[A-Za-z]?(\d{12})\b/); // Extract UTR Number

              const obj = {
                UTR_Number: utrNumber ? utrNumber[0] : null, // Apply regex
                Credit_Amount: row[3]
                  ? parseFloat(
                      row[3]
                        .toString()
                        .replace(/[₹,Cr]/g, '')
                        .trim()
                    )
                  : null, // Column D (Index 3)
              };

              if (obj['UTR_Number'] && obj['Credit_Amount'] !== null) {
                results.push(obj);
              }
            }
          });
        }
      });
    } else if (req.file.originalname.endsWith('.pdf')) {
      const pdfResults = await processPDF(filePath);
      results.push(...pdfResults);
    }

    await getRequests(results, req.body.action);
    res.render('index', {
      message: `Data uploaded to ${req.body.action}.`,
      error: null,
    });
  } catch (error) {
    console.error('Detailed error in /upload:', error.stack);
    res.status(500).render('index', {
      message: null,
      error: `Error processing file: ${error.message}`,
    });
  } finally {
    // Clean up temporary file
    if (filePath && fs.existsSync(filePath)) {
      fs.unlink(filePath, (err) => {
        if (err) console.error('Error deleting temp file:', err);
      });
    }
  }
});

// Function to extract UTR Number
function extractUTRNumber(description) {
  const utrRegex = /\b[A-Za-z]?(\d{12})\b/;
  const match = description ? description.match(utrRegex) : null;
  return match ? match[1] : null;
}

// Function to extract Credit Amount
const extractCreditAmount = (text) => {
  const match = text.match(/₹?([\d,]+\.\d{2})\s*Cr?/);
  return match ? parseFloat(match[1].replace(/,/g, '')) : null;
};

// const processPDF = async (filePath) => {
//   const dataBuffer = fs.readFileSync(filePath);
//   const pdfData = await pdf(dataBuffer);
//   const lines = pdfData.text.split('\n').map((line) => line.trim());

//   const results = [];
//   let utrNumber = null;

//   for (let i = 0; i < lines.length; i++) {
//     const line = lines[i];

//     // Extract UTR Number (assuming it's on line 1)
//     const extractedUTR = extractUTRNumber(line);

//     if (extractedUTR) {
//       utrNumber = extractedUTR;
//     }

//     // Extract Credit Amount (assuming it's on line 3 after UTR)
//     if (utrNumber && i + 2 < lines.length) {
//       const nextLine = lines[i + 2]; // Get the line 3 steps below
//       const amountMatch = nextLine.match(/₹?([\d,]+\.\d{2})\s*Cr?/);

//       if (amountMatch) {
//         const creditAmount = parseFloat(amountMatch[1].replace(/,/g, ''));

//         results.push({
//           UTR_Number: utrNumber,
//           Credit_Amount: creditAmount,
//         });

//         utrNumber = null; // Reset UTR to find next one
//       }
//     }
//   }

//   return results;
// };

const processPDF = async (filePath) => {
  const dataBuffer = fs.readFileSync(filePath);
  const pdfData = await pdf(dataBuffer);
  const lines = pdfData.text.split('\n').map((line) => line.trim());

  const results = [];

  const headerIndex = lines.findIndex((line) =>
    /date.*particular.*deposit/i.test(line.replace(/\s+/g, '').toLowerCase())
  );

  if (headerIndex !== -1) {
    // Type B (table format with fixed-width columns)
    for (let i = 0; i < lines.length - 2; i++) {
      const line1 = lines[i];
      const line2 = lines[i + 1];
      const line3 = lines[i + 2];

      const fullText = `${line1} ${line2}`;
      const utrNumber = extractUTRNumber(fullText);

      if (utrNumber) {
        const numberMatch = line3.match(/(\d+\.\d{2})/g); // grab all decimal numbers

        if (numberMatch && numberMatch.length > 0) {
          const combined = numberMatch[0]; // first amount chunk e.g. 0726123500.00

          // Remove commas just in case
          const cleanCombined = combined.replace(/,/g, '');

          // Now split: we’ll try removing 6 or 7 digits and test both
          let creditAmount = null;

          // Try 7-digit removal
          const part7 = cleanCombined.slice(7);
          if (parseFloat(part7) !== 0) {
            creditAmount = parseFloat(part7);
          } else {
            // Fallback: Try 6-digit removal
            const part6 = cleanCombined.slice(6);
            creditAmount = parseFloat(part6);
          }

          results.push({
            UTR_Number: utrNumber,
            Credit_Amount: creditAmount,
          });

          i += 2;
        }
      }
    }
  } else {
    // Type A fallback (unstructured format)
    let utrNumber = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const extractedUTR = extractUTRNumber(line);

      if (extractedUTR) {
        utrNumber = extractedUTR;
      }
      // Extract Credit Amount (assuming it's on line 3 after UTR)
      if (utrNumber && i + 2 < lines.length) {
        const nextLine = lines[i + 2]; // Get the line 3 steps below
        const amountMatch = nextLine.match(/₹?([\d,]+\.\d{2})\s*Cr?/);

        if (amountMatch) {
          const creditAmount = parseFloat(amountMatch[1].replace(/,/g, ''));

          results.push({
            UTR_Number: utrNumber,
            Credit_Amount: creditAmount,
          });

          utrNumber = null; // Reset UTR to find next one
        }
      }
    }
  }

  return results;
};

function findHeadersRow(data) {
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (
      (row.includes('Description') && row.includes('Amount (INR)')) ||
      (row.includes('Description') && row.includes('Txn Amount')) ||
      (row.includes('Description') && row.includes('Amount')) ||
      (row.includes('Description') &&
        row.includes('RefNo                         Txn Amount')) ||
      (row.includes('Description') &&
        row.includes(
          'Value Date                        RefNo                         Txn Amount (DD/MM/YYYY)'
        ))
    ) {
      return i;
    }
  }
  return null;
}

const getRequests = async (extractedData, action) => {
  try {
    let token;
    if (action === 'afro') {
      token = process.env.AFRO_TOKEN;
    } else if (action === 'aim') {
      token = process.env.AIM_TOKEN;
    } else if (action === 'aim2') {
      token = process.env.AIM2_TOKEN;
    } else {
      throw new Error(`Invalid action value: ${action}`);
    }

    if (!token) {
      throw new Error(
        'Authentication token not found in environment variables'
      );
    }

    const data = JSON.stringify({
      type: '',
      nType: 'deposit',
      start_date: '',
      end_date: '',
      isFirst: 1,
    });

    const config = {
      method: 'post',
      maxBodyLength: Infinity,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      data: data,
    };

    const response = await axios.post(
      'https://adminapi.bestlive.io/api/bank-account/request',
      data,
      config
    );

    if (response.status !== 200) {
      throw new Error(`API request failed with status: ${response.status}`);
    }

    if (!response.data?.data) {
      throw new Error('Invalid API response: No data field present');
    }

    const requestData = response.data.data;
    const matchingData = requestData.filter((data) =>
      extractedData.some(
        (filter) =>
          data.utr_number === filter.UTR_Number &&
          data.amount === filter.Credit_Amount
      )
    );

    if (matchingData.length > 0) {
      await Promise.all(
        matchingData.map((item) =>
          acceptRequests(
            item.id,
            item.user_id,
            item.utr_number,
            item.amount,
            token,
            action
          )
        )
      );
    }
  } catch (error) {
    console.error('Detailed error in getRequests:', error.stack);
    throw new Error(`getRequests failed: ${error.message}`);
  }
};

const acceptRequests = async (
  id,
  user_id,
  utr_number,
  amount,
  token,
  action
) => {
  try {
    const rem = action === 'afro' ? 'fat' : 'add1';
    const data = JSON.stringify({
      uid: user_id,
      balance: amount,
      withdraw_req_id: id,
      remark: rem,
    });

    const config = {
      method: 'post',
      maxBodyLength: Infinity,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      data: data,
    };

    const response = await axios.post(
      'https://adminapi.bestlive.io/api/app-user/action/deposit-balance',
      data,
      config
    );

    if (response.status !== 200) {
      throw new Error(`Accept request failed with status: ${response.status}`);
    }

    if (response.data.status !== 1) {
      throw new Error('Accept request failed: Invalid response status');
    }

    console.log(`Accepted UTR ${utr_number} with amount ${amount}`);
  } catch (error) {
    console.error('Detailed error in acceptRequests:', error.stack);
    throw new Error(`acceptRequests failed: ${error.message}`);
  }
};

// Start the server
app.listen(5000, () => {
  console.log('Server is running on port 5000');
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack);
  res.status(500).render('index', {
    message: null,
    error: `Unexpected error: ${err.message}`,
  });
});
