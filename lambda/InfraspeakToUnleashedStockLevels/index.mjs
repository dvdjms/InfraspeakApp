/* global fetch */
/* global crypto */
import CryptoJS from 'crypto-js';


export const handler = async (event) => {
    // const secretKey = '**************************************Fe'; // Replace with your actual secret key from Infraspeak
    // const signatureHeader = event.headers['X-Signature'] || event.headers['x-signature']; // Adjust according to Infraspeak's header name

    // This is for the secret ID in the Infrapseak webhook, which is currently disabled.
    // Create HMAC hash of the payload
    // const hmac = crypto.createHmac('sha256', secretKey);
    // hmac.update(payload);
    // const calculatedSignature = `sha256=${hmac.digest('hex')}`;

    // // Compare the signatures
    // if (calculatedSignature !== signatureHeader) {
    //     console.error('Invalid signature');
    //     return {
    //         statusCode: 403,
    //         body: JSON.stringify('Invalid signature'),
    //     };
    // }
    
    //const payload = event.body;

    try {
        
        const failedId = 686272;
        // const materialCode = '00.0130-8383';
        // const warehouseId = '16';
        // const quantity = 3;

        const stocktMovementsFromInfraspeak = await getMaterialData(failedId);

        const warehouseId = stocktMovementsFromInfraspeak[0].warehouseId.toString();
        const newGuid = generateGuid();
        const payloadForSalesOrder = await createSalesOrderPayload(newGuid, stocktMovementsFromInfraspeak, warehouseId);
        const postedSalesOrder = await postSalesOrderToUnleashed(newGuid, payloadForSalesOrder);
        
        if(postedSalesOrder){
            console.log('postedSalesOrder - Success!');
        }

        return {
            statusCode: 200,
            body: JSON.stringify({ 
                message: `Success`,
            }),
    };
    } catch (error) {
        console.error("Error parsing JSON:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ message: 'Error handling webhook event' }),
        };
    }
};


// Function to get Salespersons to obtain Salespersons' Guids
// const getSalesPersonsFromUnleashed = async () => {
//     const endpoint = `Salespersons`;
//     const response = await fetchRequestUnleashed(endpoint, 'GET');
//     console.log('response', response);
//     return response;
// };


// Function to post Sales Order on Unleashed
const postSalesOrderToUnleashed = async (guid, payload) => {
    const param = `${guid}`;
    const endpoint = `SalesOrders/${param}`;
    const response = await fetchRequestUnleashed(endpoint, 'POST', payload);
    return response;
};

// Function to create payload for posting to Unleashed
const createSalesOrderPayload = (newGuid, SalesOrderLines, warehouseId) => ({ 
    "Customer": {
        "CustomerCode": "Bank West" // for testing
    },
    "ExchangeRate": 0.10, // requires a positive number
    "Guid": newGuid,
    "OrderStatus": "Completed",
    "SalesOrderLines": SalesOrderLines.map((item, index) => ({
	    "DiscountRate": 0,
	    "LineNumber": index + 1,
	    "LineTax": 0,
	    "LineTotal": 0,
	    "OrderQuantity": item.quantity,
	    "Product": {
	        "ProductCode": '00.0130-8383' //item.materialCode
	    },
	    "UnitPrice": 0,
    })),
    "Salesperson": {
        "Guid": "5d71bd89-904d-41f3-837d-47787d277894"
    },
    "SubTotal": 0.00,
    "TaxRate": 0.00,
    "TaxTotal": 0.00,
    "Total": 0.00,
    "Warehouse": {
        "WarehouseCode": warehouseId
    }
});

// Function to perform fetch request to Unleashed
const fetchRequestUnleashed = async (endpoint, method, body = null) => {
    const url = `https://api.unleashedsoftware.com/${endpoint}`;
    const urlParam = "";
    const apiKey = process.env.API_KEY_UNLEASHED;
    const apiSignature = generateSignature(urlParam, apiKey);
    try {
        const response = await fetch(url + urlParam, {
            method: method,
            headers: {
                'Accept': 'application/json',
                'api-auth-id': process.env.API_ID_UNLEASHED,
                'api-auth-signature': apiSignature,
                'Content-Type': 'application/json',
                'client-type': 'Kontroll/UnleashedToInfraspeak'
            },
            body: body ? JSON.stringify(body) : undefined
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('Error response:', errorText);  // Log detailed error message
            throw new Error(`HTTP error! status: ${response.status}, response: ${errorText}`);
        }
        
        return await response.json();
        
    } catch (error){
        console.error('Error with fetch request:', error);
        return [];
    }
};

// Function to perform fetch request to Infraspeak
const fetchRequestInfraspeak = async (endpoint, method) => {
    const url = `https://api.sandbox.infraspeak.com/v3/${endpoint}`;
    const response = await fetch(url, {
        method: method,
        headers: {
            'Authorization': `Bearer ${process.env.AUTH_TOKEN_INFRASPEAK}`,
            'Content-Type': 'application/json',
            'User-Agent': 'InfraspeakToUnleashedStockLevels (splk.sandbox@infraspeak.com)'
        }
    });
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    return data;
};

// Function to get material_id, warehouse_id, and quantity
const getMaterialData = async (failureId) => {
        const endpoint = `failures/${failureId}?expanded=stock.material,stockTasks.material`;
        const stockMovements = await fetchRequestInfraspeak(endpoint, 'GET');
        let stockMovement = [];

        for (let material of stockMovements.included){
            if (material?.attributes?.quantity){
                let materialCode  = await getMaterialCode(material.id);
                let materialData = {
                    materialCode: materialCode,
                    warehouseId: material.attributes.warehouse_id,
                    quantity: material.attributes.quantity
                };
                stockMovement.push(materialData);
            }
        }
    return stockMovement;
};

// Function to get material_code from material_id
const getMaterialCode = async (materialId) => {
    let materialCode;
    const endpoint = `materials/${materialId}`;
    const response = await fetchRequestInfraspeak(endpoint, 'GET');
    materialCode = response.data.attributes.code;
    return materialCode;
};

// Function to generate API signature
const generateSignature = (urlParam, apiKey) => {
    const hash = CryptoJS.HmacSHA256(urlParam, apiKey);
    const hash64 = CryptoJS.enc.Base64.stringify(hash);
    return hash64;
};

// Function to generate random Guid
const generateGuid = () => {
    return crypto.randomUUID();
};
