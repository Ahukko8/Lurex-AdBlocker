// Background script - the main engine of the adblocker
// Adds popup tab blocking functionality similar to AdGuard

// Track the most recently active tab in each window
let lastActiveTabId = null;
let lastActiveWindowId = null;

// Track tabs to detect popup ads
let tabRegistry = {};
let popupTabRegistry = {};
let tabCreationTimes = {};
let tabReferrers = {};

// Handle popup detection more effectively
let potentialAutoPopupTab = null;
let autoPopupTimeout = null;

// Keep track of whether the browser is in startup mode
let isBrowserStarting = true;
setTimeout(() => { isBrowserStarting = false; }, 3000); // Give browser 3 seconds to stabilize on startup

// Default settings
const defaultSettings = {
  enabled: true,
  blockCount: 0,
  cosmeticFiltering: true,
  advancedBlocking: true,
  popupBlocking: true, // Adding popup blocking setting
  whitelistedSites: [],
  lastUpdated: Date.now()
};

// Initialize settings
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get('settings', (data) => {
    if (!data.settings) {
      chrome.storage.local.set({ settings: defaultSettings });
    }
  });
  
  // Load filter lists on installation
  updateFilterLists();
  
  // Reset stats command
  chrome.contextMenus.create({
    id: 'resetStats',
    title: 'Reset ad blocking statistics',
    contexts: ['action']
  });
});

// Check if a URL matches known ad patterns
function isAdURL(url) {
  if (!url || url === 'about:blank') {
    return false;
  }
  
  const lowercaseUrl = url.toLowerCase();
  
  // Known ad domains
  const adDomains = [
    'doubleclick.net',
    'googlesyndication.com',
    'adservice.google.com',
    'advertising.com',
    'ads.pubmatic.com',
    'adnxs.com',
    'rubiconproject.com',
    'amazon-adsystem.com',
    'adform.net',
    'casalemedia.com',
    'criteo.com',
    'taboola.com',
    'outbrain.com',
    'revcontent.com',
    'mgid.com',
    'popads.net',
    'popcash.net',
    'popunder.com',
    'clicksor.com',
    'adtng.com',
    'adtelligent.com',
    'adsterra.com',
    'propellerads.com',
    'popunder.net',
    'trafficjunky.net',
    'trafficstars.com'
  ];
  
  for (const domain of adDomains) {
    if (lowercaseUrl.includes(domain)) {
      return true;
    }
  }
  
  // Known ad URL patterns
  const adUrlPatterns = [
    '/ads/',
    '/ad/',
    '/banner/',
    '/pop/',
    '/click',
    '/track',
    'adserve',
    'popunder',
    'popup',
    'clicktrack',
    'redirect',
    'sponsor',
    'offer',
    'promo'
  ];
  
  for (const pattern of adUrlPatterns) {
    if (lowercaseUrl.includes(pattern)) {
      return true;
    }
  }
  
  return false;
}

// Check if a site is known to frequently open ad popups
function isKnownAdOpener(url) {
  if (!url) return false;
  
  const lowercaseUrl = url.toLowerCase();
  
  // Sites known for aggressive popups
  const adOpenerPatterns = [
    'torrent',
    'stream',
    'crack',
    'warez',
    'free-movie',
    'download-',
    'gamehack',
    'keygen',
    'pirate',
    'adult'
  ];
  
  for (const pattern of adOpenerPatterns) {
    if (lowercaseUrl.includes(pattern)) {
      return true;
    }
  }
  
  return false;
}

// Function to execute in the tab to detect ad content
function detectAdContent() {
  // Check for ad-related content
  const adPatterns = [
    // Common ad page title patterns
    /^(advertisement|ad|promotion|sponsor|offer)/i,
    /(special offer|limited time|act now|click here)/i,
    
    // Redirect page patterns
    /(redirecting|please wait|you are being redirected)/i,
    
    // Landing page for common ad networks
    /(doubleclick|adsystem|adserver|adnetwork|popunder|popcash|adsterra|propeller)/i
  ];
  
  // Check page title
  const title = document.title.toLowerCase();
  for (const pattern of adPatterns) {
    if (pattern.test(title)) {
      return true;
    }
  }
  
  // Check for popup behavior - window tries to resize, move, or open new windows
  if (window.opener && document.referrer === '') {
    return true; // Likely a popup that's trying to hide its origin
  }
  
  // Check for ad-specific meta tags
  const metaTags = document.querySelectorAll('meta[name], meta[property]');
  for (const meta of metaTags) {
    const name = meta.getAttribute('name') || meta.getAttribute('property') || '';
    const content = meta.getAttribute('content') || '';
    
    if ((name.includes('ad') || name.includes('sponsor') || name.includes('monetization')) ||
        (content.includes('advertisement') || content.includes('sponsored'))) {
      return true;
    }
  }
  
  // Check for redirect scripts
  const scripts = document.querySelectorAll('script');
  for (const script of scripts) {
    const scriptContent = script.textContent.toLowerCase();
    if (scriptContent.includes('window.location') && 
        (scriptContent.includes('redirect') || scriptContent.includes('timeout'))) {
      return true;
    }
    
    // Check for popup script patterns
    if (scriptContent.includes('window.open') || 
        scriptContent.includes('window.moveto') || 
        scriptContent.includes('window.resizeto')) {
      return true;
    }
  }
  
  // Check for ad network specific elements
  const adSelectors = [
    '.ad-unit', 
    '.advertisement', 
    '#ad-container', 
    'iframe[src*="ad"]',
    'a[href*="click"]',
    'a[href*="track"]',
    'a[href*="offer"]',
    // Common popup elements
    'a[target="_blank"][href*="click"]',
    'a[target="_blank"][href*="offer"]',
    'button[onclick*="window.open"]',
    'div[onclick*="window.open"]'
  ];
  
  for (const selector of adSelectors) {
    if (document.querySelectorAll(selector).length > 0) {
      return true;
    }
  }
  
  // No ad content detected
  return false;
}

// Keep track of the active tab
chrome.tabs.onActivated.addListener((activeInfo) => {
  // Skip during browser startup
  if (isBrowserStarting) return;
  
  lastActiveTabId = activeInfo.tabId;
  lastActiveWindowId = activeInfo.windowId;
  
  // When a tab becomes active, check if it's our potential auto-popup
  const { tabId } = activeInfo;
  
  // If this is our potential auto-popup tab and it just became active, it's likely 
  // an unwanted redirect popup that stole focus
  if (potentialAutoPopupTab === tabId) {
    potentialAutoPopupTab = null; // Reset the flag
    clearTimeout(autoPopupTimeout);
    
    // Check if it's an ad
    chrome.tabs.get(tabId, (tab) => {
      // Run a quick check to see if this is an ad
      if (isAdURL(tab.url) || tab.url === 'about:blank') {
        // It's an ad that just stole focus - handle it immediately
        handleAutoPopupTab(tabId);
      } else {
        // If URL doesn't immediately look like an ad, wait for a moment to check content
        setTimeout(() => checkAndHandleAutoPopupTab(tabId), 300);
      }
    }).catch(error => {
      console.error("Error getting tab:", error);
    });
  }
});

// When a new tab is created, evaluate if it might be an auto-popup
chrome.tabs.onCreated.addListener((tab) => {
  // Skip during browser startup
  if (isBrowserStarting) return;
  
  // Don't process if ad blocking is disabled
  chrome.storage.local.get('settings', (data) => {
    const settings = data.settings || defaultSettings;
    if (!settings.enabled || !settings.popupBlocking) {
      return;
    }

    // Store the tab that was active before this popup
    if (lastActiveTabId) {
      tabReferrers[tab.id] = lastActiveTabId;
    }
    
    // Store creation time
    tabCreationTimes[tab.id] = Date.now();
    
    // Detect user-initiated tab opens versus popup tabs
    // A user-initiated tab is typically opened via Ctrl+T or New Tab button
    // It will NOT have an openerTabId
    const isUserInitiated = !tab.openerTabId;
    
    // If this tab has an opener, it's potentially a popup
    if (!isUserInitiated) {
      // Mark this as a potential auto-popup
      potentialAutoPopupTab = tab.id;
      
      // Check the opener tab to see if it's a known ad opener
      if (tab.openerTabId) {
        chrome.tabs.get(tab.openerTabId, (openerTab) => {
          const suspicious = isKnownAdOpener(openerTab.url);
          
          // If the opener is suspicious, we're more likely to treat this as a popup
          // Track potential popup regardless
          popupTabRegistry[tab.id] = {
            id: tab.id,
            createdAt: Date.now(),
            openerTabId: tab.openerTabId,
            suspicious: suspicious
          };
          
          // If the URL already looks suspicious (or is about:blank, which popups often start as)
          if (isAdURL(tab.url) || tab.url === 'about:blank' || suspicious) {
            // Delay checks to allow tab to load, but be more aggressive for suspicious sites
            setTimeout(() => checkForPopupAd(tab.id), 300);
          }
        }).catch(error => {
          // If we can't get the opener tab info, still track this as a potential popup
          popupTabRegistry[tab.id] = {
            id: tab.id,
            createdAt: Date.now(),
            openerTabId: tab.openerTabId,
            suspicious: false
          };
          
          setTimeout(() => checkForPopupAd(tab.id), 500);
        });
      } else {
        // No opener tab ID but wasn't created by user (unusual)
        // This is often a sign of a sneaky popup
        popupTabRegistry[tab.id] = {
          id: tab.id,
          createdAt: Date.now(),
          openerTabId: null,
          suspicious: true
        };
        
        setTimeout(() => checkForPopupAd(tab.id), 300);
      }
      
      // Reset the potential auto-popup after a short time if it doesn't become active
      clearTimeout(autoPopupTimeout);
      autoPopupTimeout = setTimeout(() => {
        potentialAutoPopupTab = null; // Reset if not activated quickly
      }, 2000);
    }
  });
});

// Listen for tab updates to detect popup content
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Skip during browser startup
  if (isBrowserStarting) return;
  
  // Don't process if popup registry doesn't have this tab or if no URL change
  if (!popupTabRegistry[tabId] || !changeInfo.url) {
    return;
  }
  
  // Don't process if ad blocking is disabled
  chrome.storage.local.get('settings', (data) => {
    const settings = data.settings || defaultSettings;
    if (!settings.enabled || !settings.popupBlocking) {
      return;
    }
    
    // Check if it's a whitelisted site
    isWhitelisted(changeInfo.url).then(whitelisted => {
      if (whitelisted) {
        delete popupTabRegistry[tabId];
        return;
      }
      
      if (isAdURL(changeInfo.url)) {
        // It's definitely an ad popup, close it
        handleAutoPopupTab(tabId);
      } else if (changeInfo.status === 'complete') {
        // For all popup tabs, detect popup content pattern once the page is loaded
        checkAndHandleAutoPopupTab(tabId);
      }
    }).catch(error => {
      console.error("Error checking whitelist:", error);
    });
  });
});

// Listen for tab removal
chrome.tabs.onRemoved.addListener((tabId) => {
  // Clean up our registries
  delete tabRegistry[tabId];
  delete popupTabRegistry[tabId];
  delete tabCreationTimes[tabId];
  delete tabReferrers[tabId];
  
  // If this was our potential auto-popup, reset the flag
  if (potentialAutoPopupTab === tabId) {
    potentialAutoPopupTab = null;
    clearTimeout(autoPopupTimeout);
  }
});

// Check a tab for signs of being a popup ad
function checkForPopupAd(tabId) {
  // Skip during browser startup
  if (isBrowserStarting) return;
  
  // Make sure the tab still exists
  chrome.tabs.get(tabId, (tab) => {
    // Skip if it's not in our registry
    if (!popupTabRegistry[tabId]) {
      return;
    }
    
    // Get the popup info from our registry
    const popupInfo = popupTabRegistry[tabId];
    
    // Check if this tab was opened very recently (popup ads often open and steal focus fast)
    const createdRecently = Date.now() - popupInfo.createdAt < 3000;
    
    // Check if the tab is an ad by its URL
    const adUrl = isAdURL(tab.url);
    
    // If the tab is empty (about:blank) or loading, it may be a popup in progress
    const emptyOrLoading = tab.url === 'about:blank' || tab.status === 'loading';
    
    // Get opener tab (if exists)
    const openerTabId = tab.openerTabId;
    
    if (openerTabId) {
      chrome.tabs.get(openerTabId, (openerTab) => {
        // Check for common popup ad patterns
        const suspiciousOpener = isKnownAdOpener(openerTab.url);
        
        // Determine automatic popup probability
        // - Recent creation + ad URL = very likely popup
        // - Suspicious opener + empty/loading = likely popup
        // - Ad URL = likely popup
        // - Recent creation + suspicious opener = possible popup
        
        if ((createdRecently && adUrl) || 
            (suspiciousOpener && emptyOrLoading) ||
            adUrl) {
          handleAutoPopupTab(tabId);
        } else if (createdRecently && suspiciousOpener) {
          // For possibles, wait briefly then check content
          setTimeout(() => checkAndHandleAutoPopupTab(tabId), 500);
        } else {
          // For less certain cases, check when loaded
          if (tab.status === 'complete') {
            checkAndHandleAutoPopupTab(tabId);
          }
        }
      }).catch(() => {
        // Opener tab might no longer exist
        // Focus just on the current tab characteristics
        if (adUrl || (createdRecently && emptyOrLoading)) {
          handleAutoPopupTab(tabId);
        } else if (tab.status === 'complete') {
          checkAndHandleAutoPopupTab(tabId);
        }
      });
    } else {
      // No opener tab, focus on the tab's characteristics
      if (adUrl) {
        handleAutoPopupTab(tabId);
      } else if (emptyOrLoading && createdRecently) {
        // Wait a moment then check the content, as it might be loading an ad
        setTimeout(() => checkAndHandleAutoPopupTab(tabId), 300);
      } else if (tab.status === 'complete') {
        checkAndHandleAutoPopupTab(tabId);
      }
    }
  }).catch((error) => {
    // Tab likely closed or doesn't exist
    delete popupTabRegistry[tabId];
    delete tabCreationTimes[tabId];
    delete tabReferrers[tabId];
  });
}

// Check a tab we suspect is an auto-popup ad and handle it if needed
function checkAndHandleAutoPopupTab(tabId) {
  // Skip during browser startup
  if (isBrowserStarting) return;
  
  chrome.tabs.get(tabId, (tab) => {
    // Check if URL now looks like an ad
    if (isAdURL(tab.url)) {
      handleAutoPopupTab(tabId);
      return;
    }
    
    // Otherwise, run a content check
    try {
      chrome.scripting.executeScript({
        target: { tabId },
        func: detectAdContent
      }, (results) => {
        if (results && results[0] && results[0].result === true) {
          handleAutoPopupTab(tabId);
        }
      });
    } catch (e) {
      // Can't execute script, so just use URL-based detection
      if (isAdURL(tab.url)) {
        handleAutoPopupTab(tabId);
      }
    }
  }).catch(error => {
    console.error("Error checking tab:", error);
    // Clean up the tab from our registries if there was an error
    delete popupTabRegistry[tabId];
    delete tabCreationTimes[tabId];
    delete tabReferrers[tabId];
  });
}

// Handle a tab that has been identified as an auto-popup ad
function handleAutoPopupTab(tabId) {
  // Skip during browser startup
  if (isBrowserStarting) return;
  
  // Double-check the tab still exists
  chrome.tabs.get(tabId, (tab) => {
    // Get the tab that was active right before this one
    const previousTabId = tabReferrers[tabId] || lastActiveTabId;
    
    if (!previousTabId) {
      // If we don't have a previous tab, just close this one
      chrome.tabs.remove(tabId);
      return;
    }
    
    // First, focus back to the previous tab
    chrome.tabs.update(previousTabId, { active: true }, (tab) => {
      if (chrome.runtime.lastError) {
        // Previous tab no longer exists, try any tab
        chrome.tabs.query({ windowId: lastActiveWindowId }, (tabs) => {
          if (tabs && tabs.length > 0) {
            chrome.tabs.update(tabs[0].id, { active: true });
          }
        });
      }
      
      // Then close the popup tab
      chrome.tabs.remove(tabId, () => {
        // Increment block counter
        chrome.storage.local.get('settings', (data) => {
          if (data.settings) {
            const newSettings = {
              ...data.settings,
              blockCount: data.settings.blockCount + 1
            };
            chrome.storage.local.set({ settings: newSettings });
          }
        });
      });
    });
  }).catch(error => {
    // Tab might have already been closed - clean up
    delete popupTabRegistry[tabId];
    delete tabCreationTimes[tabId];
    delete tabReferrers[tabId];
  });
}

// Close a tab and increment the block counter
function closePopupTab(tabId) {
  // For our normal popup closing, use the enhanced auto-popup handler
  // which prioritizes returning to the previously active tab first
  handleAutoPopupTab(tabId);
}

// Check if URL is whitelisted
function isWhitelisted(url) {
  return new Promise((resolve) => {
    try {
      const domain = new URL(url).hostname;
      chrome.storage.local.get('settings', (data) => {
        if (data.settings && data.settings.whitelistedSites) {
          resolve(data.settings.whitelistedSites.includes(domain));
        } else {
          resolve(false);
        }
      });
    } catch (error) {
      // Invalid URL
      resolve(false);
    }
  });
}

// Helper function to get settings
function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get('settings', (data) => {
      if (data.settings) {
        resolve(data.settings);
      } else {
        resolve(defaultSettings);
      }
    });
  });
}

// Clear all registries - used when browser is closing/restarting
function clearAllRegistries() {
  tabRegistry = {};
  popupTabRegistry = {};
  tabCreationTimes = {};
  tabReferrers = {};
  potentialAutoPopupTab = null;
  clearTimeout(autoPopupTimeout);
}

// Filter lists URLs
const filterLists = {
  easyList: 'https://easylist.to/easylist/easylist.txt',
  easyPrivacy: 'https://easylist.to/easylist/easyprivacy.txt',
  adGuardBase: 'https://filters.adtidy.org/extension/chromium/filters/2.txt',
  uBlockFilters: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt'
};

// Update filter lists (would normally fetch from URLs, simplified for this example)
async function updateFilterLists() {
  // In a real extension, we would fetch these lists and parse them
  // For this example, we'll use a simplified approach with declarativeNetRequest rules
  const rules = generateBasicRules();
  
  // Save rules to storage for content script usage
  chrome.storage.local.set({ adblockRules: rules });
  
  // Update the last updated timestamp
  chrome.storage.local.get('settings', (data) => {
    if (data.settings) {
      const newSettings = {
        ...data.settings,
        lastUpdated: Date.now()
      };
      chrome.storage.local.set({ settings: newSettings });
    }
  });
}

// Generate some basic blocking rules
function generateBasicRules() {
  return {
    // Common ad networks domains to block
    domains: [
      'doubleclick.net',
      'googlesyndication.com',
      'adservice.google.com',
      'advertising.com',
      'ads.pubmatic.com',
      'adnxs.com',
      'rubiconproject.com',
      'amazon-adsystem.com',
      'adform.net',
      'casalemedia.com',
      'criteo.com',
      'taboola.com',
      'outbrain.com',
      'revcontent.com',
      'mgid.com'
    ],
    // Common ad URL patterns to block
    urlPatterns: [
      '*://*.doubleclick.net/*',
      '*://partner.googleadservices.com/*',
      '*://*.googlesyndication.com/*',
      '*://creative.ak.fbcdn.net/*',
      '*://*.adbrite.com/*',
      '*://*.exponential.com/*',
      '*://*.quantserve.com/*',
      '*://*.scorecardresearch.com/*',
      '*://*.zedo.com/*',
      '*://*.adsrvr.org/*',
      '*://pagead2.googlesyndication.com/*',
      '*://*.ads.yahoo.com/*',
      '*://ads.twitter.com/*',
      '*://*.adroll.com/*',
      '*://adserver.*/*',
      '*://ads.*/*',
      '*://ad.*/*',
      '*://*.ads.*/*',
      '*://analytics.*/*',
      '*://trackers.*/*',
      '*://tracker.*/*',
      '*://banner.*/*',
      '*://*.banner.*/*',
      '*://adimg.*/*',
      '*://*.adimg.*/*',
      '*://sponsor.*/*',
      '*://*.sponsor.*/*'
    ],
    // Common ad element selectors to hide
    cssSelectors: [
      '.ad',
      '.ads',
      '.adsbygoogle',
      '.advertisement',
      '#ad',
      '#ads',
      '[id^="google_ads_"]',
      '[id^="ad-"]',
      '[id^="ads-"]',
      '[class^="ad-"]',
      '[class^="ads-"]',
      '[class*="-ad-"]',
      '[class*="-ads-"]',
      '[class*="_ad_"]',
      '[class*="_ads_"]',
      '[id*="-ad-"]',
      '[id*="-ads-"]',
      '[id*="_ad_"]',
      '[id*="_ads_"]',
      'ins.adsbygoogle',
      'div[data-ad]',
      'div[data-ad-unit]',
      'div[data-adunit]',
      'div[id*="AdFrame"]',
      'div[class*="AdFrame"]',
      'div[class*="adContainer"]',
      'div[id*="adContainer"]',
      'div[class*="adWrapper"]',
      'div[id*="adWrapper"]',
      'div[data-google-query-id]',
      'iframe[src*="doubleclick.net"]',
      'iframe[src*="ads"]',
      'iframe[src*="ad."]',
      'iframe[src*="/ad"]',
      'iframe[id*="google_ads_frame"]',
      'amp-ad',
      'div.sponsor',
      'div.sponsored',
      'a[href*="doubleclick.net"]',
      'a[href*="googleadservices"]'
    ]
  };
}

// Update filter lists periodically (once a day)
chrome.alarms.create('updateFilters', { periodInMinutes: 1440 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'updateFilters') {
    updateFilterLists();
  }
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'resetStats') {
    chrome.storage.local.get('settings', (data) => {
      if (data.settings) {
        const newSettings = {
          ...data.settings,
          blockCount: 0
        };
        chrome.storage.local.set({ settings: newSettings });
      }
    });
  }
});

// Handle browser suspension/shutdown
chrome.runtime.onSuspend.addListener(() => {
  clearAllRegistries();
});

// Listen for messages from popup or content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getStats') {
    chrome.storage.local.get('settings', (data) => {
      try {
        console.log("Sending settings to popup:", data.settings);
        if (!data.settings) {
          // If no settings exist yet, create and save default settings
          chrome.storage.local.set({ settings: defaultSettings }, () => {
            sendResponse({ settings: defaultSettings });
          });
        } else {
          sendResponse({ settings: data.settings });
        }
      } catch (error) {
        console.error("Error sending response:", error);
        // Send default settings as fallback
        sendResponse({ settings: defaultSettings });
      }
    });
    return true; // Required for async response
  }
  
  if (message.action === 'toggleEnabled') {
    chrome.storage.local.get('settings', (data) => {
      if (data.settings) {
        const newSettings = {
          ...data.settings,
          enabled: !data.settings.enabled
        };
        chrome.storage.local.set({ settings: newSettings });
        try {
          sendResponse({ success: true, enabled: newSettings.enabled });
        } catch (error) {
          console.error("Error sending response:", error);
        }
      }
    });
    return true; // Required for async response
  }
  
  if (message.action === 'incrementBlockCount') {
    chrome.storage.local.get('settings', (data) => {
      if (data.settings) {
        // Get the count value (defaulting to 1 if not provided)
        const incrementBy = message.count || 1;
        
        const newSettings = {
          ...data.settings,
          blockCount: (data.settings.blockCount || 0) + incrementBy
        };
        console.log("Incrementing block count by", incrementBy, "to", newSettings.blockCount);
        chrome.storage.local.set({ settings: newSettings });
      } else {
        // If no settings exist yet, create them with the initial count
        const incrementBy = message.count || 1;
        const newSettings = {
          ...defaultSettings,
          blockCount: incrementBy
        };
        console.log("Creating settings with initial block count:", incrementBy);
        chrome.storage.local.set({ settings: newSettings });
      }
    });
    return false; // No response needed
  }
  
  if (message.action === 'toggleSiteWhitelist') {
    const url = message.url;
    if (!url) return false;
    
    // Extract domain from URL
    try {
      const domain = new URL(url).hostname;
      
      chrome.storage.local.get('settings', (data) => {
        if (data.settings) {
          let whitelistedSites = [...data.settings.whitelistedSites];
          
          if (whitelistedSites.includes(domain)) {
            // Remove from whitelist
            whitelistedSites = whitelistedSites.filter(site => site !== domain);
          } else {
            // Add to whitelist
            whitelistedSites.push(domain);
          }
          
          const newSettings = {
            ...data.settings,
            whitelistedSites
          };
          
          chrome.storage.local.set({ settings: newSettings });
          try {
            sendResponse({ 
              success: true, 
              whitelisted: whitelistedSites.includes(domain),
              domain
            });
          } catch (error) {
            console.error("Error sending response:", error);
          }
        }
      });
    } catch (error) {
      console.error("Error processing URL:", error);
      try {
        sendResponse({ success: false, error: "Invalid URL" });
      } catch (err) {
        console.error("Error sending error response:", err);
      }
    }
    return true; // Required for async response
  }
  
  if (message.action === 'updateSettings') {
    chrome.storage.local.get('settings', (data) => {
      if (data.settings) {
        const newSettings = {
          ...data.settings,
          ...message.settings
        };
        chrome.storage.local.set({ settings: newSettings });
        try {
          sendResponse({ success: true, settings: newSettings });
        } catch (error) {
          console.error("Error sending response:", error);
        }
      }
    });
    return true; // Required for async response
  }
  
  if (message.action === 'updateFilters') {
    updateFilterLists().then(() => {
      try {
        sendResponse({ success: true });
      } catch (error) {
        console.error("Error sending response:", error);
      }
    }).catch(error => {
      console.error("Error updating filters:", error);
      try {
        sendResponse({ success: false, error: error.message });
      } catch (err) {
        console.error("Error sending error response:", err);
      }
    });
    return true; // Required for async response
  }
  
  if (message.action === 'isWhitelisted') {
    isWhitelisted(message.url).then(whitelisted => {
      try {
        sendResponse({ whitelisted });
      } catch (error) {
        console.error("Error sending response:", error);
      }
    }).catch(error => {
      console.error("Error checking whitelist:", error);
      try {
        sendResponse({ whitelisted: false, error: error.message });
      } catch (err) {
        console.error("Error sending error response:", err);
      }
    });
    return true; // Required for async response
  }
  
  return false; // No response needed for other messages
});