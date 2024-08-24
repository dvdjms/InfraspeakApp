/* global fetch */
import CryptoJS from 'crypto-js';


export const handler = async (event) => {
    try {
        //await getInfraspeakWarehouse();
        const stockOnHandUnleashed = await fetchStockOnHandFromUnleashed();
        const processedStockOnHand = await processStockOnHand(stockOnHandUnleashed);
        const postedStock = await postStockToInfraspeak(processedStockOnHand);
        console.log('Posted Stock: ', JSON.stringify(postedStock, null, 2));
        
        return {
            statusCode: 200,
            body: JSON.stringify({ 
                message: `Success`,
            }),
        };
    } catch (error) {
        console.error('Error handling webhook event:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ message: 'Error handling webhook event' })
        };
    }
};


// Fetch request to Unleashed
const fetchRequesUnleashed = async (endpoint) => {
    const url = `https://api.unleashedsoftware.com/${endpoint}`;
    const urlParam = "";
    const apiKey = process.env.API_KEY;
    const apiSignature = generateSignature(urlParam, apiKey);
    
    try {
        const response = await fetch(url + urlParam, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'api-auth-id': process.env.API_ID,
                'api-auth-signature': apiSignature,
                'Content-Type': 'application/json',
                'client-type': 'Kontroll/UnleashedToInfraspeak'
            }
        });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return await response.json();
        
    } catch (error){
        console.error('Error fetching products:', error);
        return [];
    }
};


// Function to fetch all products from Infraspeak
const fetchRequestInfraspeak = async (endpoint, method, body = null) => {
    const url = `https://api.sandbox.infraspeak.com/v3/${endpoint}`;

    try {
        const response = await fetch(url, {
            method: method,
            headers: {
                'Authorization': `Bearer ${process.env.API_KEY_INFRASPEAK}`,
                'Content-Type': 'application/json',
                'User-Agent': 'InfraspeakToUnleashedStockLevels (splk.sandbox@infraspeak.com)'
            },
            body: body ? JSON.stringify(body) : undefined
        });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return await response.json();
    }catch (error) {
        console.error(`Error ${method}ing to Infraspeak:`, error);
        throw error;
    }
};


// Post stock quantities to Infraspeak
const postStockToInfraspeak = async (stockToPost) => {
    const postedResults = await Promise.all(stockToPost.map(async (warehouse) => {
        const productCode = warehouse.ProductCode.toUpperCase().trim();
        const averageCost = warehouse.AverageCost;
        const warehouseId = parseInt(warehouse.WarehouseId, 10);
        const quantityUnleashed = warehouse.AvailableQty;

        try {
            const materialId_ = await getMaterialIdFromInfraspeak(productCode);
            const materialId = parseInt(materialId_, 10);

            if (materialId) {
                const quantityInfraspeak = await getMaterialQuantitiesFromInfraspeak(materialId, warehouseId);
                
                if (quantityUnleashed > quantityInfraspeak) {
                    const quantityToAdd = quantityUnleashed - quantityInfraspeak;
                    return await fetchRequestInfraspeak("stock-movements", "POST", stockMovementPayloadAdd(materialId, quantityToAdd, warehouseId));
                } else if (quantityUnleashed < quantityInfraspeak) {
                    const quantityToConsume = quantityInfraspeak - quantityUnleashed;
                    return await fetchRequestInfraspeak("stock-movements", "POST", stockMovementPayloadConsume(materialId, quantityToConsume, warehouseId));
                } else {
                    console.log(`No stock movement needed for product code: ${productCode} in warehouse: ${warehouseId}`);
                    return null;
                }
            } else {
                console.warn(`Material ID not found for product code: ${productCode}`);
                return null;
            }
        } catch (error) {
            console.error(`Failed to post stock for product code: ${productCode} in warehouse: ${warehouseId}`, error);
            return null;
        }
    }));
    return postedResults.filter(result => result !== null);
};


// Get material quantities from Infraspeak
const getMaterialQuantitiesFromInfraspeak = async (materialId, warehouseId) => {
    let quantity = 0;
    let pageNumber = 1;

    while (true) {
        const endpoint = `warehouses/material-quantities?limit=1000&page=${pageNumber}`;
        const materialQuantityInfraspeak = await fetchRequestInfraspeak(endpoint, 'GET');

        for (let qty of materialQuantityInfraspeak.data) {
            if (qty.attributes?.material_id === materialId && qty.attributes?.warehouse_id === warehouseId) {
                quantity = parseInt(qty.attributes?.stock_quantity, 10) || 0;
                return quantity;
            }
        }
        // Check for the next page using the pagination links
        if (!materialQuantityInfraspeak.links?.next) {
            break; 
        }
        pageNumber++;
    }
    return quantity;
};


// Get material_id from product_code on Infraspeak
const getMaterialIdFromInfraspeak = async (productCode) => {
    let materialId;
    let pageNumber = 1;
    
    while (true) {
        const endpoint = `materials/all?limit=1000&page=${pageNumber}`;
        const response = await fetchRequestInfraspeak(endpoint, "GET");
        const materialAll = Array.isArray(response.data) ? response.data : [];

        for (let material of materialAll) {
            if (material?.attributes?.code?.toUpperCase().trim() === productCode && material?.attributes?.parent_id !== null) {
                materialId = material.id;
                console.log('Found material ID with parent:', material.id);
                return materialId;
            }
        }
        if (!response.links?.next) {
            break;
        }
        pageNumber++;
    }
    return materialId;
};


// Payload for stock-movements (add) endpoint
const stockMovementPayloadAdd = (materialId, quantity, warehouseId) => ({
    "_type": "stock-movement",
    "action": "ADD",
    "warehouse_id": warehouseId,
    "stocks": [
        {
           "material_id": materialId,
           "quantity": quantity
        }
    ]
});


// Payload for stock-movements (abate) endpoint
const stockMovementPayloadConsume = (materialId, quantity, warehouseId) => ({
    "_type": "stock-movement",
    "action": "ABATE",
    "warehouse_id": warehouseId,
    "stocks": [
        {
           "material_id": materialId,
           "quantity": quantity
        }
    ]
});


// Payload for stocks endpoint
// const createStockPayload = (materialId, quantity, warehouseId) => ({
//     "material_id": materialId,
//     "quantity": quantity,
//     "warehouse_id": warehouseId,
// });


// Fetch stock on hand from Unleashed
const fetchStockOnHandFromUnleashed = async () => {
    let allData = [];
    let pageNumber = 1;
    let totalPages = 1;

    while (pageNumber <= totalPages) {
        const endpoint = `StockOnHand/Page/${pageNumber}`;
        let data = await fetchRequesUnleashed(endpoint);

        if (data && data.Items) {
            allData = allData.concat(data.Items);
            totalPages = data.Pagination?.NumberOfPages || 1;
            pageNumber++;
        } else {
            break;
        }
    }
    return { Items: allData };
};


// Get all required fields ready to payload
const processStockOnHand = async (UnleashedStock) => {
    const extractedData = UnleashedStock.Items.map(item => ({
        ProductGuid: item.ProductGuid,
        ProductCode: item.ProductCode,
        AverageCost: item.AvgCost
    }));
    
    let result = [];
    
    for (const item of extractedData) {
        const productUID = item.ProductGuid;
        const warehousesAndQuantities = await fetchWarehousesAndQuantitiesFromUnleashed(productUID);

        for (const warehouseItem of warehousesAndQuantities.Items) {
            const warehouseId = warehouseItem.WarehouseId;
            const availableQty = warehouseItem.AvailableQty;
            const warehouseCode = await fetchWarehouseCodes(warehouseId);
     
            result.push({
                ProductCode: item.ProductCode,
                AverageCost: item.AverageCost,
                WarehouseId: warehouseCode,
                AvailableQty: availableQty
            });
        }
    }
    return result;
};


// Get all warehouses on Unleashed relating to a product Id
const fetchWarehousesAndQuantitiesFromUnleashed = async (productUID) => {
    const url = `StockOnHand/${productUID}/AllWarehouses`;
    const data = fetchRequesUnleashed(url);
    return data;
};


// Obtain warehouse code from warehouse Id on Unleashed
const fetchWarehouseCodes = async (warehouseId) => {
    const url = `Warehouses`;
    const warehouses = await fetchRequesUnleashed(url);
    let warehouseCode;

    for (let warehouse of warehouses.Items){
        if(warehouseId === warehouse.Guid) {
            warehouseCode = warehouse.WarehouseCode;
        }
    }
    return warehouseCode;
};


// Function to generate API signature
const generateSignature = (urlParam, apiKey) => {
    const hash = CryptoJS.HmacSHA256(urlParam, apiKey);
    const hash64 = CryptoJS.enc.Base64.stringify(hash);
    return hash64;
};
