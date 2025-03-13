// Popup script - controls the user interface for the extension

// DOM elements
let adblockToggle;
let statusText;
let blockedCount;
let percentBlocked;
let currentSite;
let whitelistToggle;
let cosmeticToggle;
let advancedToggle;
let popupToggle;
let lastUpdated;
let updateFilters;

// Get current tab information
let currentTabId = null;
let currentTabUrl = null;
let currentTabDomain = null;

// Initialize popup
document.addEventListener('DOMContentLoaded', async () => {
  // Initialize DOM element references
  adblockToggle = document.getElementById('adblock-toggle');
  statusText = document.getElementById('status-text');
  blockedCount = document.getElementById('blocked-count');
  percentBlocked = document.getElementById('percent-blocked');
  currentSite = document.getElementById('current-site');
  whitelistToggle = document.getElementById('whitelist-toggle');
  cosmeticToggle = document.getElementById('cosmetic-toggle');
  advancedToggle = document.getElementById('advanced-toggle');
  popupToggle = document.getElementById('popup-toggle');
  lastUpdated = document.getElementById('last-updated');
  updateFilters = document.getElementById('update-filters');
  
  // Make sure we have DOM elements before continuing
  if (!adblockToggle || !statusText || !blockedCount) {
    console.error('Required DOM elements not found');
    return;
  }
  
  // Get current tab
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs[0]) {
      currentTabId = tabs[0].id;
      currentTabUrl = tabs[0].url;
      
      try {
        // Extract domain name
        const url = new URL(currentTabUrl);
        currentTabDomain = url.hostname;
        if (currentSite) {
          currentSite.textContent = currentTabDomain;
        }
      } catch (error) {
        console.error('Error extracting domain:', error);
        if (currentSite) {
          currentSite.textContent = 'Unknown site';
        }
      }
    }
  } catch (e) {
    console.error('Error getting current tab:', e);
  }
  
  // Add event listeners
  setupEventListeners();
  
  // Load settings and update UI
  loadSettings();
});

// Setup all event listeners
function setupEventListeners() {
  // Main toggle
  if (adblockToggle) {
    adblockToggle.addEventListener('change', toggleAdblocking);
  }
  
  // Whitelist toggle
  if (whitelistToggle) {
    whitelistToggle.addEventListener('click', toggleWhitelist);
  }
  
  // Cosmetic filtering toggle
  if (cosmeticToggle) {
    cosmeticToggle.addEventListener('change', toggleCosmetic);
  }
  
  // Advanced blocking toggle
  if (advancedToggle) {
    advancedToggle.addEventListener('change', toggleAdvanced);
  }
  
  // Popup blocking toggle
  if (popupToggle) {
    popupToggle.addEventListener('change', togglePopupBlocking);
  }
  
  // Update filters button
  if (updateFilters) {
    updateFilters.addEventListener('click', updateFilterLists);
  }
}

// Toggle main ad blocking
function toggleAdblocking() {
  if (!adblockToggle || !statusText) return;
  
  const enabled = adblockToggle.checked;
  statusText.textContent = enabled ? 'Active' : 'Paused';
  
  chrome.runtime.sendMessage({
    action: 'toggleEnabled'
  }, (response) => {
    // Handle potential message port closing
    if (chrome.runtime.lastError) {
      console.error("Error toggling enabled state:", chrome.runtime.lastError.message);
      return;
    }
    
    // If the toggle was successful, refresh the current page
    if (response && response.success && currentTabId) {
      chrome.tabs.reload(currentTabId);
    }
  });
}

// Toggle whitelist for current site
function toggleWhitelist() {
  if (!whitelistToggle || !currentTabUrl) return;
  
  chrome.runtime.sendMessage({
    action: 'toggleSiteWhitelist',
    url: currentTabUrl
  }, (response) => {
    // Handle potential message port closing
    if (chrome.runtime.lastError) {
      console.error("Error toggling whitelist:", chrome.runtime.lastError.message);
      return;
    }
    
    if (response && response.success) {
      updateWhitelistButton(response.whitelisted);
      
      // Refresh the page to apply changes
      if (currentTabId) {
        chrome.tabs.reload(currentTabId);
      }
    }
  });
}

// Toggle cosmetic filtering
function toggleCosmetic() {
  if (!cosmeticToggle) return;
  
  const enabled = cosmeticToggle.checked;
  
  chrome.runtime.sendMessage({
    action: 'updateSettings',
    settings: {
      cosmeticFiltering: enabled
    }
  }, (response) => {
    // Handle potential message port closing
    if (chrome.runtime.lastError) {
      console.error("Error updating cosmetic settings:", chrome.runtime.lastError.message);
      return;
    }
    
    // If the update was successful, refresh the current page
    if (response && response.success && currentTabId) {
      chrome.tabs.reload(currentTabId);
    }
  });
}

// Toggle advanced blocking
function toggleAdvanced() {
  if (!advancedToggle) return;
  
  const enabled = advancedToggle.checked;
  
  chrome.runtime.sendMessage({
    action: 'updateSettings',
    settings: {
      advancedBlocking: enabled
    }
  }, (response) => {
    // Handle potential message port closing
    if (chrome.runtime.lastError) {
      console.error("Error updating advanced settings:", chrome.runtime.lastError.message);
      return;
    }
    
    // If the update was successful, refresh the current page
    if (response && response.success && currentTabId) {
      chrome.tabs.reload(currentTabId);
    }
  });
}

// Toggle popup blocking
function togglePopupBlocking() {
  if (!popupToggle) return;
  
  const enabled = popupToggle.checked;
  
  chrome.runtime.sendMessage({
    action: 'updateSettings',
    settings: {
      popupBlocking: enabled
    }
  }, (response) => {
    // Handle potential message port closing
    if (chrome.runtime.lastError) {
      console.error("Error updating popup settings:", chrome.runtime.lastError.message);
      return;
    }
    
    // No need to reload for this setting as it applies to new popups
  });
}

// Update filter lists
function updateFilterLists() {
  if (!updateFilters) return;
  
  updateFilters.textContent = 'Updating...';
  updateFilters.disabled = true;
  
  chrome.runtime.sendMessage({
    action: 'updateFilters'
  }, (response) => {
    // Handle potential message port closing
    if (chrome.runtime.lastError) {
      console.error("Error updating filters:", chrome.runtime.lastError.message);
      updateFilters.textContent = 'Update Now';
      updateFilters.disabled = false;
      return;
    }
    
    // After update, refresh settings to show new "last updated" time
    loadSettings();
    
    // Reset button
    updateFilters.textContent = 'Update Now';
    updateFilters.disabled = false;
    
    // Refresh the page to apply new filters
    if (currentTabId) {
      chrome.tabs.reload(currentTabId);
    }
  });
}

// Load extension settings
function loadSettings() {
  if (!blockedCount || !statusText || !percentBlocked) {
    console.error('Required DOM elements for settings not found');
    return;
  }
  
  console.log('Loading settings...');
  
  chrome.runtime.sendMessage({ action: 'getStats' }, (response) => {
    if (chrome.runtime.lastError) {
      console.error("Error getting stats:", chrome.runtime.lastError.message);
      return;
    }
    
    console.log('Received settings response:', response);
    
    if (response && response.settings) {
      const settings = response.settings;
      
      // Update toggle states if DOM elements exist
      if (adblockToggle) adblockToggle.checked = settings.enabled;
      if (cosmeticToggle) cosmeticToggle.checked = settings.cosmeticFiltering !== false;
      if (advancedToggle) advancedToggle.checked = settings.advancedBlocking !== false;
      if (popupToggle) popupToggle.checked = settings.popupBlocking !== false;
      
      // Update status text
      statusText.textContent = settings.enabled ? 'Active' : 'Paused';
      
      // Update blocked count
      blockedCount.textContent = formatNumber(settings.blockCount || 0);
      
      // Update last updated time if DOM element exists
      if (lastUpdated && settings.lastUpdated) {
        lastUpdated.textContent = formatDate(settings.lastUpdated);
      }
      
      // Check if current domain is whitelisted
      if (currentTabDomain && settings.whitelistedSites && whitelistToggle) {
        const isWhitelisted = settings.whitelistedSites.includes(currentTabDomain);
        updateWhitelistButton(isWhitelisted);
      }
      
      // Calculate and display percent blocked
      // This is an estimate based on typical ad density
      const blockCount = settings.blockCount || 0;
      const totalRequests = Math.max(100, Math.round(blockCount * 1.5));
      const percentage = Math.min(100, Math.round((blockCount / totalRequests) * 100));
      percentBlocked.textContent = `${percentage}%`;
    } else {
      console.error('No settings found in response');
      // Set default values in case no settings were found
      blockedCount.textContent = '0';
      percentBlocked.textContent = '0%';
      statusText.textContent = 'Active';
    }
  });
}

// Format large numbers with commas
function formatNumber(num) {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Format date in relative time
function formatDate(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  
  // Less than a minute
  if (diff < 60000) {
    return 'Updated just now';
  }
  
  // Less than an hour
  if (diff < 3600000) {
    const minutes = Math.floor(diff / 60000);
    return `Updated ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  }
  
  // Less than a day
  if (diff < 86400000) {
    const hours = Math.floor(diff / 3600000);
    return `Updated ${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  }
  
  // More than a day
  const days = Math.floor(diff / 86400000);
  return `Updated ${days} ${days === 1 ? 'day' : 'days'} ago`;
}

// Update whitelist button state
function updateWhitelistButton(isWhitelisted) {
  if (!whitelistToggle) return;
  
  if (isWhitelisted) {
    whitelistToggle.textContent = 'Enable on this site';
    whitelistToggle.classList.add('whitelisted');
  } else {
    whitelistToggle.textContent = 'Disable on this site';
    whitelistToggle.classList.remove('whitelisted');
  }
}