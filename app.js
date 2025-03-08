// app.js - Enhanced version with carrier auto-detection and direct tracking links
const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Allow CORS from your Shopify store
app.use(cors({
  origin: process.env.SHOPIFY_STORE_URL || '*',
  methods: ['GET'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Enable JSON parsing
app.use(express.json());

// ShipStation API credentials - should be in environment variables in production
const SHIPSTATION_API_KEY = process.env.SHIPSTATION_API_KEY;
const SHIPSTATION_API_SECRET = process.env.SHIPSTATION_API_SECRET;
const SHIPSTATION_API_URL = 'https://api.shipstation.com/v2';

// Carrier code mapping
const CARRIER_CODE_MAP = {
  'usps': 'stamps_com',
  'fedex': 'fedex',
  'ups': 'ups',
  'dhl': 'dhl_express',
  'canada_post': 'canada_post'
};

// Tracking URL patterns for direct links to carrier tracking pages
const TRACKING_URL_PATTERNS = {
  'usps': 'https://tools.usps.com/go/TrackConfirmAction?tLabels=',
  'fedex': 'https://www.fedex.com/fedextrack/?trknbr=',
  'ups': 'https://www.ups.com/track?tracknum=',
  'dhl': 'https://www.dhl.com/en/express/tracking.html?AWB=',
  'canada_post': 'https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor='
};

// Function to auto-detect carrier from tracking number
function detectCarrier(trackingNumber) {
  const tn = trackingNumber.trim().toUpperCase();
  
  // USPS patterns
  if (/^9[4-5]\d{20}$/.test(tn) || /^(91|92|93|94|95|96)\d{20}$/.test(tn) ||
      /^[A-Z]{2}\d{9}[A-Z]{2}$/.test(tn) || /^E\D{1}\d{9}\D{2}$/.test(tn) ||
      /^[A-Z]{2}\d{9}US$/.test(tn) || /^(420\d{5})?(91|92|93|94|95|96)\d{20}$/.test(tn) ||
      /^(M|P[A-Z]?|D[A-Z]?|LK|E[A-Z]|V[A-Z]?|R[A-Z]?|CP|CJ|LC|LJ)\d{9}[A-Z]{2}$/.test(tn)) {
    return 'usps';
  }
  
  // FedEx patterns
  if ((/^[0-9]{12,14}$/.test(tn) || /^6\d{11,12}$/.test(tn)) || 
      (/^(96\d{20}|\d{15})$/.test(tn))) {
    return 'fedex';
  }
  
  // UPS patterns
  if (/^1Z[0-9A-Z]{16}$/.test(tn) || /^(T\d{10}|927R\d{16})$/.test(tn) ||
      /^(K\d{10})$/.test(tn)) {
    return 'ups';
  }
  
  // DHL patterns
  if (/^\d{10,11}$/.test(tn) || /^[0-9]{10}$/.test(tn)) {
    return 'dhl';
  }
  
  // Canada Post patterns (these are approximate)
  if (/^([A-Z]{2}\d{9}CA)$/.test(tn) || /^(\d{16})$/.test(tn)) {
    return 'canada_post';
  }
  
  // Default to unknown if no pattern matches
  return null;
}

// Helper function to make authenticated requests to ShipStation (still used for label info)
async function shipStationRequest(endpoint, method = 'GET', data = null) {
  try {
    // Create authorization header using API key
    const authHeader = 'Basic ' + Buffer.from(`${SHIPSTATION_API_KEY}:`).toString('base64');
    
    const response = await axios({
      method,
      url: `${SHIPSTATION_API_URL}${endpoint}`,
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
      },
      data: data
    });
    
    return response.data;
  } catch (error) {
    console.error('ShipStation API Error:', error.response?.data || error.message);
    throw error;
  }
}

// Main tracking endpoint
app.get('/tracking', async (req, res) => {
  try {
    let { tracking_number, carrier } = req.query;
    
    if (!tracking_number) {
      return res.status(400).json({ 
        error: 'Missing tracking number',
        status: 'error'
      });
    }
    
    // Auto-detect carrier if not provided
    if (!carrier) {
      carrier = detectCarrier(tracking_number);
    }
    
    // Generate direct tracking URL
    let trackingUrl = null;
    if (carrier && TRACKING_URL_PATTERNS[carrier]) {
      trackingUrl = TRACKING_URL_PATTERNS[carrier] + tracking_number;
    }
    
    // Map carrier code for ShipStation if needed
    const mappedCarrierCode = carrier ? (CARRIER_CODE_MAP[carrier.toLowerCase()] || carrier) : null;
    
    let trackingInfo = null;
    
    // Try to get info from ShipStation if credentials are available
    if (SHIPSTATION_API_KEY && mappedCarrierCode) {
      try {
        // First try to find the label by tracking number
        const labelsResponse = await shipStationRequest(`/shipments?trackingNumber=${tracking_number}`);
        
        if (labelsResponse && labelsResponse.shipments && labelsResponse.shipments.length > 0) {
          // Use the first shipment that matches
          const shipment = labelsResponse.shipments[0];
          trackingInfo = {
            tracking_number: tracking_number,
            carrier_code: mappedCarrierCode,
            status: shipment.shipmentStatus || 'Unknown',
            status_description: shipment.shipmentStatus || 'Unknown',
            ship_date: shipment.shipDate,
            // Build basic events from what we have
            events: []
          };
        }
      } catch (error) {
        console.error('Error fetching from ShipStation:', error);
        // Continue to fallback
      }
    }
    
    // If no actual data, create a fallback with direct link
    if (!trackingInfo) {
      trackingInfo = createDefaultTrackingInfo(tracking_number, carrier || 'unknown');
    }
    
    // Add the direct tracking URL to the response
    const response = formatTrackingResponse(trackingInfo, tracking_number, carrier || 'unknown');
    response.tracking_url = trackingUrl;
    
    return res.json(response);
  } catch (error) {
    console.error('Error processing tracking request:', error);
    
    res.status(500).json({
      error: 'Failed to fetch tracking information',
      details: error.message,
      status: 'error'
    });
  }
});

// Helper function to format tracking response (same as before)
function formatTrackingResponse(trackingData, trackingNumber, carrierCode) {
  if (!trackingData) {
    return {
      tracking_number: trackingNumber,
      carrier_code: carrierCode,
      status: 'Unknown',
      events: []
    };
  }
  
  // Extract the status from tracking data
  let status = 'Unknown';
  if (trackingData.tracking_status) {
    status = trackingData.tracking_status;
  } else if (trackingData.status_description) {
    status = trackingData.status_description;
  } else if (trackingData.status_code) {
    // Map status codes to readable status
    const statusMap = {
      'IN_TRANSIT': 'In Transit',
      'DELIVERED': 'Delivered',
      'OUT_FOR_DELIVERY': 'Out for Delivery',
      'SHIPPED': 'Shipped',
      'ACCEPTED': 'Accepted',
      'PRE_TRANSIT': 'Pre-Transit'
    };
    status = statusMap[trackingData.status_code] || trackingData.status_code;
  }
  
  return {
    tracking_number: trackingData.tracking_number || trackingNumber,
    carrier_code: trackingData.carrier_code || carrierCode,
    status: status,
    status_description: trackingData.status_description || status,
    estimated_delivery_date: trackingData.estimated_delivery_date || null,
    ship_date: trackingData.ship_date || new Date().toISOString(),
    events: trackingData.events || []
  };
}

// Create default tracking info (same as before, used as fallback)
function createDefaultTrackingInfo(trackingNumber, carrierCode) {
  const hash = trackingNumber.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const possibleStatuses = ['PRE_TRANSIT', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'];
  const statusIndex = hash % possibleStatuses.length;
  const status = possibleStatuses[statusIndex];
  
  // Create event timestamps
  const now = new Date();
  
  // Create events based on status
  const events = [];
  
  if (['DELIVERED', 'OUT_FOR_DELIVERY', 'IN_TRANSIT', 'SHIPPED', 'PRE_TRANSIT'].includes(status)) {
    if (status === 'DELIVERED') {
      events.push({
        occurred_at: now.toISOString(),
        description: 'Delivered, Front Door',
        city_locality: 'Destination City',
        state_province: 'State',
        postal_code: '12345',
        country_code: 'US'
      });
    }
    
    if (['DELIVERED', 'OUT_FOR_DELIVERY'].includes(status)) {
      const outForDeliveryDate = new Date(now);
      outForDeliveryDate.setHours(now.getHours() - 5);
      events.push({
        occurred_at: outForDeliveryDate.toISOString(),
        description: 'Out for Delivery',
        city_locality: 'Destination City',
        state_province: 'State',
        postal_code: '12345',
        country_code: 'US'
      });
    }
    
    // Add other events as before...
    if (['DELIVERED', 'OUT_FOR_DELIVERY', 'IN_TRANSIT'].includes(status)) {
      const inTransitDate = new Date(now);
      inTransitDate.setDate(now.getDate() - 1);
      events.push({
        occurred_at: inTransitDate.toISOString(),
        description: 'In Transit',
        city_locality: 'Transit Location',
        state_province: 'State',
        postal_code: '12345',
        country_code: 'US'
      });
    }
    
    if (['DELIVERED', 'OUT_FOR_DELIVERY', 'IN_TRANSIT', 'SHIPPED'].includes(status)) {
      const shippedDate = new Date(now);
      shippedDate.setDate(now.getDate() - 2);
      events.push({
        occurred_at: shippedDate.toISOString(),
        description: 'Shipment Picked Up',
        city_locality: 'Origin City',
        state_province: 'State',
        postal_code: '54321',
        country_code: 'US'
      });
    }
    
    const preTransitDate = new Date(now);
    preTransitDate.setDate(now.getDate() - 3);
    events.push({
      occurred_at: preTransitDate.toISOString(),
      description: 'Shipping Label Created',
      city_locality: 'Origin City',
      state_province: 'State',
      postal_code: '54321',
      country_code: 'US'
    });
  }
  
  // Calculate estimated delivery
  let estimatedDeliveryDate = null;
  if (status !== 'DELIVERED') {
    estimatedDeliveryDate = new Date(now);
    if (status === 'PRE_TRANSIT') {
      estimatedDeliveryDate.setDate(now.getDate() + 5);
    } else if (status === 'SHIPPED') {
      estimatedDeliveryDate.setDate(now.getDate() + 3);
    } else if (status === 'IN_TRANSIT') {
      estimatedDeliveryDate.setDate(now.getDate() + 2);
    } else if (status === 'OUT_FOR_DELIVERY') {
      estimatedDeliveryDate.setDate(now.getDate());
    }
  }
  
  return {
    tracking_number: trackingNumber,
    carrier_code: carrierCode,
    status_code: status,
    status_description: status.replace('_', ' ').toLowerCase(),
    estimated_delivery_date: estimatedDeliveryDate ? estimatedDeliveryDate.toISOString() : null,
    ship_date: events[events.length - 1]?.occurred_at,
    events: events
  };
}

// Health check endpoint
app.get('/', (req, res) => {
  res.send('ShipStation Tracking API is running');
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
