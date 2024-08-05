import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import CryptoJS from 'crypto-js'; 
import fetch from 'node-fetch';

const secretsManager = new SecretsManagerClient({ region: 'eu-west-2' });

async function getSecrets() {
    const command = new GetSecretValueCommand({ SecretId: 'InfraspeakApp/Production/ApiCredentials' });
    const response = await secretsManager.send(command);
    return JSON.parse(response.SecretString);
};


export const handler = async (event) => {
    try {
        const [productsUnleashed, productsInfraspeak] = await Promise.all([
            fetchProductsUnleashed(),
            fetchProductsInfraspeak()
        ]);

        const unmatchedProductCodes = await matchProductsBetweenPlatforms(productsUnleashed.products, productsInfraspeak);
        const productDetails = await getProductDetails(unmatchedProductCodes, productsUnleashed.data);
        const groupName = productDetails?.productGroup?.GroupName || "DEFAULTFOLDER";

        // // Ensure warehouseId is an array and extract codes or default to [15]
        const UnleashedWarehouseCodes = Array.isArray(productDetails?.warehouseId)
            ? productDetails.warehouseId.map(warehouse => parseInt(warehouse?.Warehouse?.WarehouseCode, 10)).filter(Boolean)
            : [18];

        const uniqueWarehouseCodes = [...new Set(UnleashedWarehouseCodes)];

        const warehouseIds = await checkWarehouseExists(uniqueWarehouseCodes);
        //warehouseIds.pop(16);
        //warehouseIds.push(18);
        console.log('Matching warehouseIds', warehouseIds);
        
        
        const handleWarehouses = async () => {
    
            if (warehouseIds.length > 0) {
                try {
                    const folderId = await createOrGetFolder(groupName, warehouseIds);
                    console.log(`Completed processing for warehouse ${warehouseIds}`);
                    return await createMaterial(productDetails, folderId, warehouseIds);
             
                } catch (error) {
                    console.error(`Error processing warehouses ${warehouseIds}:`, error);
                }
            } else {
                try {
                    console.log('No matching warehouses found, defaulting to warehouse 18');
                    const folderId = await createOrGetFolder(groupName, [18]);
                    console.log('Completed processing for default warehouse 18');
                    return await createMaterial(productDetails, folderId, [18]);
                } catch (error) {
                    console.error('Error processing default warehouse 18:', error);
                }
            }
        };
        
        const handleWarehousesResponse = await handleWarehouses();
        const materialIdForStock = handleWarehousesResponse.data?.attributes?.material_id;

        const stockQuantity = 1;
        const stockWarehouseId = 16;
    
        const createStockResponse = await createStockMovement(materialIdForStock, stockQuantity, stockWarehouseId);
        console.log('createStockResponse', createStockResponse);

        return {
            statusCode: 200,
            body: JSON.stringify({ 
                message: `Success`,
                count: unmatchedProductCodes.length,
                createStockResponse: createStockResponse,
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


// Function to fetch all products from Infraspeak
const makeInfraspeakAPIRequest = async (endpoint, method, body = null) => {
    const { API_KEY_INFRASPEAK } = await getSecrets();
    const url = `https://api.sandbox.infraspeak.com/v3/${endpoint}`;
    try {
        const response = await fetch(url, {
            method: method,
            headers: {
                'Authorization': `Bearer ${API_KEY_INFRASPEAK}`,
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


const fetchProductsInfraspeak = async (pageNumber = 1) => {
    const endpoint = `materials/all?limit=1000&page=${pageNumber}`;
    const data = await makeInfraspeakAPIRequest(endpoint, 'GET');
    const products = data.data.map(product => product.attributes?.full_code?.trim().toUpperCase()).filter(Boolean);
    if (data.links?.next) {
        const nextProducts = await fetchProductsInfraspeak(pageNumber + 1);
        return products.concat(nextProducts);
    }
    return products;
};


const fetchProductsUnleashed = async (pageNumber = 1) => {
    const { API_ID, API_KEY } = await getSecrets();
    const url = `https://api.unleashedsoftware.com/Products/Page/${pageNumber}`;
    const urlParam = "";
    const apiSignature = generateSignature(urlParam, API_KEY);

    try {
        const response = await fetch(url + urlParam, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'api-auth-id': API_ID,
                'api-auth-signature': apiSignature,
                'Content-Type': 'application/json',
                'client-type': 'Kontroll/UnleashedProductsPoll'
            }
        });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        const products = data.Items.map(product => product.ProductCode.toUpperCase());
        
        if (data.Pagination?.NumberOfPages > pageNumber) {
            const nextProducts = await fetchProductsUnleashed(pageNumber + 1);
            return { products: products.concat(nextProducts.products), data: data.Items.concat(nextProducts.data) };
        }
        return { products, data: data.Items };
    } catch (error) {
        console.error('Error fetching products:', error);
        return [];
    }
};


// Function to process and return unmatched products
const matchProductsBetweenPlatforms = async (unleashedData, infraspeakData) => {
    const infraspeakSet = new Set(infraspeakData);
    const unmatachedCodes = unleashedData.filter(code => !infraspeakSet.has(code));
    return unmatachedCodes;
};


// Function to get details of the first unmatched product
const getProductDetails = async (products, UnleashedData) => {
    if (!products || products.length === 0) {
        throw new Error("No products provided to fetch details.");
    }
    //const productCode = products[0];
    const productCode = "15.HBF-08-08"; ///////////////////////////////////////////////////////////////////////////////////
    const productDetails = UnleashedData.find(product => product.ProductCode.toUpperCase() === productCode);
    //console.log('productDetails', productDetails.InventoryDetails[0].Warehouse);
    if (productDetails) {
        const productData = {
            "productCode": productDetails.ProductCode,
            "productDescription": productDetails.ProductDescription,
            "averageLandPrice": productDetails.AverageLandPrice,
            "unitOfMeasure": productDetails.UnitOfMeasure,
            "productGroup": productDetails.ProductGroup,
            "warehouseId":  productDetails.InventoryDetails
        };
        return productData;
    } else {
        console.log("No matching product found for productCode:", productCode);
        return null;
    }
};


const postToInfraspeak = async (endpoint, payload) => {
    return await makeInfraspeakAPIRequest(endpoint, "POST", payload);
};


const checkFolderExists = async (groupName) => {
    const folderName = groupName; 
    const folders = await fetchFoldersInfraspeak();
    for(let folder of folders){
        if(folderName === folder.folder){
            return folder.material_id;
        }
    }
    console.log('folder does not exist');
    return null;
};


const checkWarehouseExists = async (warehouseCodes) => {
    const endpoint = `warehouses`;
    const response = await makeInfraspeakAPIRequest(endpoint, 'GET');
    const warehouseList = response.data;
    const warehouseCodeSet = new Set(warehouseCodes);
    const matchedCodes = warehouseList
        .filter(warehouse => warehouseCodeSet.has(warehouse.attributes.warehouse_id))
        .map(warehouse => warehouse.attributes.warehouse_id);
        return matchedCodes;
};


const fetchFoldersInfraspeak = async (pageNumber = 1) => {
    const endpoint = `materials?limit=1000&page=${pageNumber}`;
    const data = await makeInfraspeakAPIRequest(endpoint, 'GET');
    const folders = data.data.map(product => ({
        folder: product.attributes?.full_code?.trim().toUpperCase(),
        material_id: product.attributes?.material_id
    })).filter(folder => folder.folder);
    if (data.links?.next) {
        const nextProducts = await fetchProductsInfraspeak(pageNumber + 1);
        return folders.concat(nextProducts);
    }
    return folders;
};


const createOrGetFolder = async (folderName, warehouseIdsList) => {
    let folderId = await checkFolderExists(folderName);
    if (!folderId) {
        const infraspeakFolderResponse = await postToInfraspeak('materials', createFolderPayload(folderName, warehouseIdsList));
        folderId = infraspeakFolderResponse.data.id;
        return folderId;
    }
    return folderId;
};
        
        
const createMaterial = async (productDetails, folderId, warehouseIdsList) => {
    const infraspeakMaterialResponse = await postToInfraspeak('materials', createMaterialPayload(productDetails, folderId, warehouseIdsList));
    return infraspeakMaterialResponse;
};


const createStockMovement = async (materialid, quantity, warehouse) => {
    const infraspeakMaterialResponse = await postToInfraspeak('stock-movements', createStockMovementPayload(materialid, quantity, warehouse));
    return infraspeakMaterialResponse;
};


const createFolderPayload = (folderCode, warehouseIds) => ({
    "_type": "FOLDER",
    "name": "Folder",
    "code": folderCode,
    "observation": "",
    "mean_price": 0,
    "units": "",
    "material_warehouse": warehouseIds.map(warehouseId => ({
        "warehouse_id": warehouseId,
        "min_stock": 1,
        "mean_price": 0,
        "observation": "string"
    })),
    "default_sell_price": 0,
    "default_sell_vat": 0
});

const createMaterialPayload = (productDetails, folderId, warehouseIds) => ({
    "_type": "MATERIAL",
    "name": productDetails.productDescription,
    "code": productDetails.productCode,
    "observation": "",
    "mean_price": productDetails.averageLandPrice,
    "units": "un",
    "material_warehouse": warehouseIds.map(warehouseId => ({
        "warehouse_id": warehouseId,
        "min_stock": 1,
        "mean_price": 0,
        "observation": "string"
    })),
    "parent_id": folderId,
    "default_sell_price": 0,
    "default_sell_vat": 0
});

const createStockMovementPayload = (materialId, quantity, warehouseId) => ({
    "_type": "stock-movement",
    "action": "ADD",
    "warehouse_id": warehouseId,
    "observation": "string",
    "stocks": [
        {
            "material_id": materialId,
            "quantity": quantity
        }
    ]
});


// Function to generate API signature for Unleashed
const generateSignature = (urlParam, apiKey) => {
    const hash = CryptoJS.HmacSHA256(urlParam, apiKey);
    const hash64 = CryptoJS.enc.Base64.stringify(hash);
    return hash64;
};