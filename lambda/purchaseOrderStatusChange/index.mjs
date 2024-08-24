/* global fetch */
/* global AWS */
import CryptoJS from 'crypto-js';
import { DynamoDBClient, PutItemCommand, DeleteItemCommand, ScanCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall, marshall } from '@aws-sdk/util-dynamodb';
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

const dynamoDb = new DynamoDBClient({ region: 'eu-west-2' });
const tableName = 'purchase-orders-unleashed';
const sns = new SNSClient({ region: "eu-west-2" });


export const handler = async (event) => {
    try {
        // Step 1: Retrieve purchase orders
        const purchaseOrders = await getPurchaseOrders();
        if (!purchaseOrders || purchaseOrders.length === 0) {
            console.log('No purchase orders retrieved.');
            return { statusCode: 200, body: 'No purchase orders to process.' };
        }

        // Step 2: Process the retrieved purchase orders
        const processedOrders = await processPurchaseOrders(purchaseOrders);
        if (processedOrders === null) {
            console.log('No updates detected, no message sent.');
            return { statusCode: 200, body: 'No updates to process.' };
        }

        // Step 3: Create a meaningful message for the changes
        const createdMessage = await createMessage(processedOrders);
        console.log('createdMessage', createdMessage);

        // Step 4: Send the message via SNS
        const sentSNSMessage = await sendSNSMessage(createdMessage);
        console.log('SNS Message sent successfully:', sentSNSMessage);

        return { statusCode: 200, body: 'Purchase orders processed and message sent successfully.' };

    } catch (error) {
        console.error('Error processing purchase orders:', error);
        return { statusCode: 500, body: 'Failed to process purchase orders.' };
    }
};



const processPurchaseOrders = async (purchaseOrders) => {
    const result = [];

    try {
        // Step 1: Retrieve all existing purchase orders from DynamoDB
        const existingOrders = await getExistingOrders();

        // Step 2: Determine which orders to delete
        const ordersToDelete = findOrdersToDelete(existingOrders, purchaseOrders);
        await deleteOrders(ordersToDelete, result);

        // Step 3: Process incoming orders
        await processIncomingOrders(purchaseOrders, existingOrders, result);

    } catch (error) {
        console.error(`Error accessing DynamoDB: ${error.message}`);
        return null;
    }

    return result.length ? result : null;
};


const getExistingOrders = async () => {
    const scanCommand = new ScanCommand({
        TableName: tableName,
        ProjectionExpression: 'purchaseOrderNumber, purchaseOrderStatus, lastModifiedOn, lastModifiedBy'
    });

    const existingOrdersData = await dynamoDb.send(scanCommand);
    return existingOrdersData.Items.map(item => unmarshall(item));
};

const findOrdersToDelete = (existingOrders, purchaseOrders) => {
    const incomingOrderNumbers = purchaseOrders.map(order => order.purchaseOrderNumber);
    return existingOrders.filter(order => !incomingOrderNumbers.includes(order.purchaseOrderNumber));
};


const deleteOrders = async (ordersToDelete, result) => {
    for (const order of ordersToDelete) {
        const deleteItemCommand = new DeleteItemCommand({
            TableName: tableName,
            Key: marshall({ purchaseOrderNumber: order.purchaseOrderNumber })
        });
        await dynamoDb.send(deleteItemCommand);
        console.log(`Deleted purchase order: ${order.purchaseOrderNumber}`);
        result.push({
            purchaseOrderNumber: order.purchaseOrderNumber,
            oldStatus: order.purchaseOrderStatus,
            newStatus: 'Deleted',
            lastModifiedOn: order.lastModifiedOn,
            lastModifiedBy: order.lastModifiedBy
        });
    }
};


const processIncomingOrders = async (purchaseOrders, existingOrders, result) => {
    for (const order of purchaseOrders) {
        const existingOrder = existingOrders.find(eo => eo.purchaseOrderNumber === order.purchaseOrderNumber);

        if (existingOrder) {
            await updateOrderIfNecessary(existingOrder, order, result);
        } else if (order.purchaseOrderStatus !== 'Complete') {
            await insertNewOrder(order, result);
        }
    }
};


const updateOrderIfNecessary = async (existingOrder, order, result) => {
    if (order.purchaseOrderStatus === 'Complete') {
        await deleteCompletedOrder(existingOrder, order, result);
    } else if (existingOrder.purchaseOrderStatus !== order.purchaseOrderStatus) {
        await updateOrder(existingOrder, order, result);
    }
};

const deleteCompletedOrder = async (existingOrder, order, result) => {
    const key = { purchaseOrderNumber: { S: order.purchaseOrderNumber } };
    const deleteItemCommand = new DeleteItemCommand({ TableName: tableName, Key: key });
    await dynamoDb.send(deleteItemCommand);
    console.log(`Deleted purchase order: ${order.purchaseOrderNumber}`);
    result.push({
        purchaseOrderNumber: order.purchaseOrderNumber,
        oldStatus: existingOrder.purchaseOrderStatus,
        newStatus: 'Complete',
        lastModifiedOn: order.lastModifiedOn,
        lastModifiedBy: order.lastModifiedBy
    });
};

const updateOrder = async (existingOrder, order, result) => {
    const updatedOrder = {
        purchaseOrderNumber: order.purchaseOrderNumber,
        purchaseOrderStatus: order.purchaseOrderStatus,
        lastModifiedOn: order.lastModifiedOn,
        lastModifiedBy: order.lastModifiedBy
    };

    const putItemCommand = new PutItemCommand({
        TableName: tableName,
        Item: marshall(updatedOrder, { removeUndefinedValues: true })
    });
    await dynamoDb.send(putItemCommand);

    result.push({
        purchaseOrderNumber: order.purchaseOrderNumber,
        oldStatus: existingOrder.purchaseOrderStatus,
        newStatus: order.purchaseOrderStatus,
        lastModifiedOn: order.lastModifiedOn,
        lastModifiedBy: order.lastModifiedBy
    });
};

const insertNewOrder = async (order, result) => {
    const newOrder = {
        purchaseOrderNumber: order.purchaseOrderNumber,
        purchaseOrderStatus: order.purchaseOrderStatus,
        lastModifiedOn: order.lastModifiedOn,
        lastModifiedBy: order.lastModifiedBy
    };

    const putItemCommand = new PutItemCommand({
        TableName: tableName,
        Item: marshall(newOrder)
    });
    await dynamoDb.send(putItemCommand);
    console.log(`Inserted new purchase order: ${order.purchaseOrderNumber}`);

    result.push({
        purchaseOrderNumber: order.purchaseOrderNumber,
        oldStatus: null,
        newStatus: order.purchaseOrderStatus,
        lastModifiedOn: order.lastModifiedOn,
        lastModifiedBy: order.lastModifiedBy
    });
};


// Function to fetch and paginate purchase orders
const getPurchaseOrders = async () => {
    const pageNumber = 1 ;
    let allData = [];
    
    while (true){
        const endpoint = `PurchaseOrders/Page/${pageNumber}`;
        const purchaseOrders = await fetchRequestUnleashed(endpoint, 'GET');
        allData = allData.concat(purchaseOrders);

        if (!purchaseOrders.links?.next) {
            break; 
        }
        pageNumber++;
    }
    const processedData = await processFetchedPurchaseOrders(allData);
    return processedData;
};


// Function to get list of purchase order numbers, statuses, modified on, and modified by
const processFetchedPurchaseOrders = (data) => {
    return data.flatMap(item =>
        item.Items.map(item => ({
            purchaseOrderNumber: item.OrderNumber,
            purchaseOrderStatus: item.OrderStatus,
            lastModifiedOn: formatDateTime(item.LastModifiedOn),
            lastModifiedBy: item.LastModifiedBy
        }))
    );
};


// Function to fetch purchase orders from Unleashed one page at a time
const fetchRequestUnleashed = async (endpoint, method) => {
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
                'client-type': 'Kontroll/PurchaseOrderStatusChange'
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


// Function to create a message with the response object
const createMessage = (updates) => {
    
    if (updates.length === 0) {
        return 'No purchase orders were updated.';
    }
    let message = 'The following purchase order(s) have had changes:\n\n';
    
    updates.forEach(update => {
        const { purchaseOrderNumber, oldStatus, newStatus, lastModifiedOn, lastModifiedBy } = update;
        
        if (oldStatus === null) {
            message += `- Purchase order number ${purchaseOrderNumber} has been created with a status of ${newStatus}. Last modified on: ${lastModifiedOn} by ${lastModifiedBy}.\n`;
        } else if (newStatus === 'Deleted') {
            message += `- Purchase order number ${purchaseOrderNumber} has been deleted (previous status: ${oldStatus}). Last modified on: ${lastModifiedOn} by ${lastModifiedBy}.\n`;
        } else {
            message += `- Purchase order number ${purchaseOrderNumber} has changed status from ${oldStatus} to ${newStatus}. Last modified on: ${lastModifiedOn} by ${lastModifiedBy}.\n`;
        }
    });
    return message;
};

// Function to send message to subscribed emails
const sendSNSMessage = async (message) => {
    const snsParams = {
        Message: message,
        Subject: "Your Purchase Order Update",
        TopicArn: "arn:aws:sns:eu-west-2:891377393286:purchase-orders-unleashed"
    };

    try {
        const data = await sns.send(new PublishCommand(snsParams));
        console.log("Notification sent successfully:", data);
        return "Notification sent successfully:";
    } catch (error) {
        console.error("Error sending notification:", error);
    }
};

// Function to get meaningful date/time
const formatDateTime = (lastModifiedOn) => {
    const timestamp = parseInt(lastModifiedOn.match(/\d+/)[0], 10);
    const date = new Date(timestamp);
    return date.toLocaleString();
};

// Function to generate API signature
const generateSignature = (urlParam, apiKey) => {
    const hash = CryptoJS.HmacSHA256(urlParam, apiKey);
    const hash64 = CryptoJS.enc.Base64.stringify(hash);
    return hash64;
};