const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const xls = require('xlsjs');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

const app = express();

// let authToken = null; // Global variable to store the authentication token

// Set storage for uploaded files
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, `indus.csv`);
  },
});

// Initialize multer upload
const upload = multer({ storage });

// Set EJS as the template engine
app.set('views', __dirname + '/views');
app.set('view engine', 'ejs');

// Serve static files
// app.use(express.static('public'));
app.use(express.static(__dirname + 'public'));

// Render the index page
app.get('/', (req, res) => {
  res.render('index', { message: null });
});

// Set up a route for file upload
app.post('/upload', upload.single('csvFile'), (req, res) => {
  // Check if a file was uploaded
  if (!req.file) {
    return res.status(400).send('No file uploaded.');
  }

  const results = [];

  // Read and parse the CSV file
  const filePath = path.join(__dirname, `uploads/indus.csv`);
  if (req.file.originalname.endsWith('.csv')) {
    // fs.createReadStream(filePath)
    //   .pipe(csv({ skipLines: 17 })) // Skip the first 17 lines (headers)
    //   .on('data', (data) => {
    //     // Remove leading and trailing whitespace from specific fields
    //     const trimmedData = {
    //       'Sr.No.': data['Sr.No.'],
    //       Date: data['Date'],
    //       Type: data['Type'],
    //       Description: data[' Description'].trim(),
    //       Debit: data[' Debit '].trim(),
    //       Credit: data['Credit '].trim(),
    //       Balance: data['Balance'],
    //     };
    //     results.push(trimmedData);
    //   })
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (data) => {
        // Extract Amount and UTR columns
        const extractedData = {
          UTR_Number: data['UTR'],
          Credit_Amount: parseFloat(data['Amount']), // Convert to number format,
        };
        results.push(extractedData);
      })
      .on('end', () => {
        const response = JSON.stringify(results);
        const extractedData = JSON.parse(response);
        // .filter((entry) => entry.Type === 'Transfer Credit')
        // .map((entry) => ({
        //   UTR_Number:
        //     entry.Description?.match(/(?<=\/)\d+(?=\/)/)?.[0] || null,
        //   Credit_Amount: parseFloat(entry.Credit),
        // }))
        // .filter(
        //   (entry, index, self) =>
        //     entry.UTR_Number &&
        //     index === self.findIndex((e) => e.UTR_Number === entry.UTR_Number)
        // );

        // console.log(extractedData);
        getRequests(extractedData, req.body.action);
        res.render('index', {
          message: `Data uploaded to ${req.body.action}.`,
        });
      });
  } else if (req.file.originalname.endsWith('.xls')) {
    const workbook = xls.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const jsonData = xls.utils.sheet_to_json(worksheet, {
      header: 1,
    });

    // const headers = jsonData[3]; // Assuming headers are on line 6 (0-based index)
    const headers = jsonData[5]; // Assuming headers are on line 6 (0-based index)
    // const data = jsonData.slice(4); // Assuming data starts from line 7 (0-based index)
    const data = jsonData.slice(6); // Assuming data starts from line 7 (0-based index)
    // console.log(headers);
    // const extractedData = data
    //   .map((row) => {
    //     const obj = {};
    //     headers.forEach((header, index) => {
    //       // Remove starting 4 zeros from 'Chq./Ref.No.' and rename it as 'UTR_number'
    //       if (header === 'Description') {
    //         const chqRefNo = row[index];
    //         obj['UTR_Number'] = chqRefNo;
    //         // obj['UTR_Number'] = chqRefNo && chqRefNo.replace(/^0{4}/, '');
    //       } else if (header === 'Amount (INR)') {
    //         obj['Credit_Amount'] = row[index];
    //       } else {
    //         obj[header] = row[index];
    //       }
    //     });
    //     return obj;
    //   })
    //   .filter((entry) => {
    //     // Check if the 'Date' field matches the desired format 'dd/mm/yy'
    //     // const dateRegex = /^\d{2}\/\d{2}\/\d{2}$/;
    //     const dateRegex = /^(0[1-9]|[12][0-9]|3[01])\/(0[1-9]|1[0-2])\/\d{4}$/;
    //     const isValidDate = dateRegex.test(entry['Value Date']);

    //     // Check if the 'Deposit_amount' field is a valid number
    //     const depositAmt = entry['Credit_Amount'];
    //     const isValidDepositAmt =
    //       typeof depositAmt === 'number' &&
    //       !isNaN(depositAmt) &&
    //       depositAmt > 0;

    //     return isValidDate && isValidDepositAmt;
    //   })
    //   .map(({ UTR_Number, Credit_Amount }) => ({
    //     UTR_Number,
    //     Credit_Amount,
    //   }));

    const extractedData = data
      .map((row) => {
        const obj = {};
        headers.forEach((header, index) => {
          if (header === 'Description') {
            // Extract only the 12-digit number from the 'Description' field
            const utrNumber = row[index].match(/\d{12}/);
            obj['UTR_Number'] = utrNumber ? utrNumber[0] : null;
          } else if (header === 'Amount (INR)') {
            // } else if (header === 'Amount') {
            // Convert 'Amount (INR)' to a number
            const creditAmount = parseFloat(row[index].replace(/,/g, ''));
            // const creditAmount = parseFloat(row[index]);
            obj['Credit_Amount'] = isNaN(creditAmount) ? null : creditAmount;
          } else if (header === 'Value date') {
            // Assuming 'Value date' is in 'dd/mm/yyyy' format, you can add validation if needed
            obj['Date'] = row[index];
          } else {
            obj[header] = row[index];
          }
        });
        return obj;
      })
      // .filter((entry) => {
      //   // Check if the 'Date' field matches the desired format 'dd/mm/yyyy'
      //   const dateRegex = /^\d{2}\/\d{2}\/\d{4}$/; // Assuming date format is dd/mm/yyyy
      //   const isValidDate = dateRegex.test(entry['Date']);

      //   // Check if the 'Credit_Amount' field is a valid number
      //   const depositAmt = entry['Credit_Amount'];
      //   const isValidDepositAmt = !isNaN(depositAmt) && depositAmt > 0;

      //   return isValidDate && isValidDepositAmt;
      // })
      .map(({ UTR_Number, Credit_Amount }) => ({
        UTR_Number,
        Credit_Amount,
      }));

    // console.log(extractedData);
    getRequests(extractedData, req.body.action);
    res.render('index', { message: `Data uploaded to ${req.body.action}.` });
  } else if (req.file.originalname.endsWith('.xlsx')) {
    const workbook = xls.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const jsonData = xls.utils.sheet_to_json(worksheet, {
      header: 1,
    });

    const headers = jsonData[12]; // Assuming headers are on line 6 (0-based index)
    const data = jsonData.slice(13); // Assuming data starts from line 7 (0-based index)

    const extractedData = data
      .map((row) => {
        const obj = {};
        headers.forEach((header, index) => {
          if (header === 'Description') {
            // Extract only the 12-digit number from the 'Description' field
            // const utrNumber = row[index].match(/\d{12}/);
            const utrNumber = row[index] ? row[index].match(/\d{12}/) : null;
            obj['UTR_Number'] = utrNumber ? utrNumber[0] : null;
          } else if (header === 'Amount') {
            // Convert 'Amount (INR)' to a number
            // const creditAmount = parseFloat(row[index].replace(/,/g, ''));
            const creditAmount = parseFloat(row[index]);
            obj['Credit_Amount'] = isNaN(creditAmount) ? null : creditAmount;
          } else if (header === 'Value date') {
            // Assuming 'Value date' is in 'dd/mm/yyyy' format, you can add validation if needed
            obj['Date'] = row[index];
          } else {
            obj[header] = row[index];
          }
        });
        return obj;
      })
      .filter(
        ({ UTR_Number, Credit_Amount }) =>
          UTR_Number !== null || Credit_Amount !== null
      ) // Filter out objects with undefined UTR_Number or Credit_Amount
      // .filter((entry) => {
      //   // Check if the 'Date' field matches the desired format 'dd/mm/yyyy'
      //   const dateRegex = /^\d{2}\/\d{2}\/\d{4}$/; // Assuming date format is dd/mm/yyyy
      //   const isValidDate = dateRegex.test(entry['Date']);

      //   // Check if the 'Credit_Amount' field is a valid number
      //   const depositAmt = entry['Credit_Amount'];
      //   const isValidDepositAmt = !isNaN(depositAmt) && depositAmt > 0;

      //   return isValidDate && isValidDepositAmt;
      // })
      .map(({ UTR_Number, Credit_Amount }) => ({
        UTR_Number,
        Credit_Amount,
      }));

    // console.log(extractedData);
    getRequests(extractedData, req.body.action);
    res.render('index', { message: `Data uploaded to ${req.body.action}.` });
  }
});

// get requests from Wuwexchange
const getRequests = async (extractedData, action) => {
  try {
    if (action === 'dafa') {
      token = process.env.D_TOKEN;
    } else if (action === 'coexchange') {
      token = process.env.C_TOKEN;
    }

    let data = JSON.stringify({
      type: '',
      nType: 'deposit',
      start_date: '',
      end_date: '',
      isFirst: 1,
    });
    let config = {
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
      throw new Error('Request failed with status: ' + response.status);
    } else if (typeof response.data === 'object' && response.data !== null) {
      // Data is an object
      const requestData = response.data.data;
      // console.log(requestData);
      // console.log(extractedData);

      const matchingData = [];
      requestData.forEach((data) => {
        extractedData.forEach((filter) => {
          if (
            data.utr_number === filter.UTR_Number &&
            data.amount === filter.Credit_Amount
          ) {
            matchingData.push(data);
          }
        });
      });

      // console.log(matchingData);

      if (matchingData.length > 0) {
        // Matching entries found
        matchingData.forEach((item) => {
          const { id, user_id, utr_number, amount } = item;
          // console.log(id, user_id, utr_number, amount);
          console.log(`UTR Number: ${utr_number} Amount: ${amount}`);
          // accept requests
          acceptRequests(id, user_id, utr_number, amount, token);
        });
      }
    } else {
      throw new Error('Invalid response data format');
    }
  } catch (error) {
    // Handle any errors
    console.error(error);
  }
};
// accept requests
const acceptRequests = async (id, user_id, utr_number, amount, token) => {
  try {
    // let token = await login();
    let data = JSON.stringify({
      uid: user_id,
      balance: amount,
      withdraw_req_id: id,
      remark: 'sat',
    });
    let config = {
      method: 'post',
      maxBodyLength: Infinity,
      headers: {
        authority: 'adminapi.bestlive.io',
        accept: 'application/json, text/plain, */*',
        'accept-language': 'en-IN,en;q=0.9,mr;q=0.8,lb;q=0.7',
        authorization: `Bearer ${token}`,
        'cache-control': 'no-cache, no-store',
        'content-type': 'application/json',
        encryption: 'false',
        origin: 'https://admin.dafaexch9.com',
        referer: 'https://admin.dafaexch9.com/',
        // origin: "https://admin.coexchange.com",
        // referer: "https://admin.coexchange.com/",
        'sec-ch-ua':
          '"Chromium";v="112", "Google Chrome";v="112", "Not:A-Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'cross-site',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36',
      },
      data: data,
    };
    const response = await axios.post(
      'https://adminapi.bestlive.io/api/app-user/action/deposit-balance',
      data,
      config
    );
    if (response.status !== 200) {
      throw new Error('Request failed with status: ' + response.status);
    } else if (response.data.status === 1) {
      console.log(response.data);
      // processUTRNumber(utrNumber, amount);
    } else {
      throw new Error('Invalid response data format');
    }
  } catch (error) {
    // Handle any errors
    console.error(error);
  }
};

// getRequests(extractedData);

// Start the server
app.listen(5000, () => {
  console.log('Server is running on port 5000');
});
