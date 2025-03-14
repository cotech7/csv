const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const xls = require('xlsjs');
const xlsx = require('xlsx');
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
    if (['.csv', '.xls', '.xlsx'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV, XLS, and XLSX files are supported'));
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

      const headers = jsonData[5]; // Assuming headers on line 6
      const data = jsonData.slice(6); // Assuming data starts from line 7

      data.forEach((row) => {
        const obj = {};
        headers.forEach((header, index) => {
          if (header === 'Description') {
            const utrNumber = row[index] ? row[index].match(/\d{12}/) : null;
            obj['UTR_Number'] = utrNumber ? utrNumber[0] : null;
          } else if (header === 'Amount (INR)') {
            const creditAmount = parseFloat(
              row[index] ? row[index].toString().replace(/,/g, '') : NaN
            );
            obj['Credit_Amount'] = isNaN(creditAmount) ? null : creditAmount;
          }
        });
        if (obj['UTR_Number'] && obj['Credit_Amount']) {
          results.push(obj);
        }
      });
    } else if (req.file.originalname.endsWith('.xlsx')) {
      const workbook = xlsx.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const jsonData = xlsx.utils.sheet_to_json(worksheet, { header: 1 });

      const headers = jsonData[3]; // Assuming headers on line 4
      const data = jsonData.slice(4); // Assuming data starts from line 5

      data.forEach((row) => {
        const obj = {};
        headers.forEach((header, index) => {
          if (header === 'Description') {
            const utrNumber = row[index] ? row[index].match(/\d{12}/) : null;
            obj['UTR_Number'] = utrNumber ? utrNumber[0] : null;
          } else if (header === 'Amount') {
            const creditAmount = parseFloat(
              row[index] ? row[index].toString().replace(/,/g, '') : NaN
            );
            obj['Credit_Amount'] = isNaN(creditAmount) ? null : creditAmount;
          }
        });
        if (obj['UTR_Number'] && obj['Credit_Amount']) {
          results.push(obj);
        }
      });
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

function extractUTRNumber(description) {
  const utrRegex = /\b[A-Za-z]?(\d{12})\b/;
  const match = description ? description.match(utrRegex) : null;
  return match ? match[1] : null;
}

const getRequests = async (extractedData, action) => {
  try {
    let token;
    if (action === 'afro') {
      token = process.env.AFRO_TOKEN;
    } else if (action === 'aim') {
      token = process.env.AIM_TOKEN;
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
    const rem = action === 'aim' ? 'add1' : 'fat';
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
