// Content script - runs on web pages to block ads

// Check if the current site is whitelisted
async function checkIfWhitelisted() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      action: 'isWhitelisted',
      url: window.location.href
    }, (response) => {
      resolve(response && response.whitelisted);
    });
  });
}

// Get settings and rules
async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['settings', 'adblockRules'], (data) => {
      resolve({
        settings: data.settings || { enabled: true, cosmeticFiltering: true },
        rules: data.adblockRules || { domains: [], cssSelectors: [] }
      });
    });
  });
}

// Main ad blocking function
async function blockAds() {
  const { settings, rules } = await getSettings();
  const whitelisted = await checkIfWhitelisted();
  
  // Don't block if extension is disabled or site is whitelisted
  if (!settings.enabled || whitelisted) {
    return;
  }
  
  // Block ads using CSS selectors (cosmetic filtering)
  if (settings.cosmeticFiltering) {
    applyElementBlockingRules(rules.cssSelectors);
  }
  
  // Block trackers and iframes that could contain ads
  if (settings.advancedBlocking) {
    applyAdvancedBlocking();
  }
  
  // Watch for new elements being added to the DOM
  observeDOMChanges(rules.cssSelectors, settings);
}

// Apply element blocking rules
function applyElementBlockingRules(selectors) {
  // Create a style element to hide ads
  const style = document.createElement('style');
  style.setAttribute('data-adblocker', 'true');
  
  // Combine all selectors and set display: none
  const cssRules = selectors.join(', ') + ' { display: none !important; }';
  style.textContent = cssRules;
  
  // Add style to head for immediate effect
  if (document.head) {
    document.head.appendChild(style);
  } else {
    // If head doesn't exist yet, wait for it
    const observer = new MutationObserver(() => {
      if (document.head) {
        document.head.appendChild(style);
        observer.disconnect();
      }
    });
    observer.observe(document.documentElement, { childList: true });
  }
  
  // Find and remove ad elements
  removeAdElements(selectors);
}

// Remove ad elements that match our selectors
function removeAdElements(selectors) {
  try {
    const elements = document.querySelectorAll(selectors.join(', '));
    let count = 0;
    
    elements.forEach(element => {
      element.style.setProperty('display', 'none', 'important');
      count++;
    });
    
    // If we blocked any ads, increment the counter
    if (count > 0) {
      chrome.runtime.sendMessage({
        action: 'incrementBlockCount',
        count: count
      });
    }
  } catch (error) {
    // Handle errors with complex selectors
    console.log('Error in ad blocking selectors', error);
  }
}

// Advanced blocking techniques
function applyAdvancedBlocking() {
  // Block third-party iframes that could contain ads
  const iframes = document.querySelectorAll('iframe');
  iframes.forEach(iframe => {
    try {
      const src = iframe.src.toLowerCase();
      if (src && (
          src.includes('ad') || 
          src.includes('banner') || 
          src.includes('sponsor') || 
          src.includes('promotion') ||
          src.includes('doubleclick') ||
          src.includes('adsystem')
        )) {
        iframe.style.setProperty('display', 'none', 'important');
        chrome.runtime.sendMessage({ action: 'incrementBlockCount' });
      }
    } catch (e) {
      // Skip iframes with no src attribute
    }
  });
  
  // Look for common ad script patterns
  const scripts = document.querySelectorAll('script');
  scripts.forEach(script => {
    try {
      const src = script.src.toLowerCase();
      if (src && (
          src.includes('ads') || 
          src.includes('analytics') || 
          src.includes('tracker') ||
          src.includes('pixel') ||
          src.includes('advert') ||
          src.includes('stat.')
        )) {
        script.remove();
        chrome.runtime.sendMessage({ action: 'incrementBlockCount' });
      }
    } catch (e) {
      // Skip scripts with no src attribute
    }
  });

  // Look for and block popup-related attributes and event handlers
  blockPopupTriggers();
}

// Block popup triggers in the page
function blockPopupTriggers() {
  // Find and disable onclick handlers that might open popups
  const possiblePopupTriggers = document.querySelectorAll('a[target="_blank"], a[onclick], button[onclick], div[onclick]');
  
  possiblePopupTriggers.forEach(element => {
    const onclickAttr = element.getAttribute('onclick') || '';
    const href = element.getAttribute('href') || '';
    
    // Check if the element has popup-related characteristics
    if (
      onclickAttr.toLowerCase().includes('window.open') ||
      href.includes('javascript:') && href.includes('window.open')
    ) {
      // Either remove the onclick entirely or replace it with a safe version
      element.removeAttribute('onclick');
      
      // If it's a link, prevent default for suspicious ones but don't break legitimate links
      if (element.tagName === 'A') {
        const originalHref = element.getAttribute('href');
        if (originalHref && (originalHref.includes('javascript:') || isAdURL(originalHref))) {
          element.addEventListener('click', (e) => {
            e.preventDefault();
            chrome.runtime.sendMessage({ action: 'incrementBlockCount' });
          });
        }
      }
      
      chrome.runtime.sendMessage({ action: 'incrementBlockCount' });
    }
  });
}

// Check if a URL is likely an ad URL
function isAdURL(url) {
  if (!url) return false;
  
  const lowerUrl = url.toLowerCase();
  const adPatterns = [
    'ad', 'ads', 'advert', 'banner', 'pop', 'popup', 'click', 'track',
    'offer', 'promo', 'deal', 'sponsor', 'doubleclick', 'adsystem'
  ];
  
  return adPatterns.some(pattern => lowerUrl.includes(pattern));
}

// Watch for DOM changes to block dynamically loaded ads
function observeDOMChanges(selectors, settings) {
  // Create mutation observer to detect new ad elements
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        mutation.addedNodes.forEach(node => {
          // Check if the node is an element node
          if (node.nodeType === 1) {
            // Check if element matches ad selectors
            if (elementMatchesSelectors(node, selectors)) {
              node.style.setProperty('display', 'none', 'important');
              chrome.runtime.sendMessage({ action: 'incrementBlockCount' });
            }
            
            // Check children for ad elements
            if (node.querySelectorAll) {
              removeAdElements(selectors);
            }
            
            // If new scripts are added, check for popup code
            if (settings.advancedBlocking) {
              blockPopupTriggers();
            }
          }
        });
      }
    }
  });
  
  // Start observing
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}

// Check if element matches any of our selectors
function elementMatchesSelectors(element, selectors) {
  for (const selector of selectors) {
    try {
      if (element.matches(selector)) {
        return true;
      }
    } catch (e) {
      // Skip invalid selectors
    }
  }
  return false;
}

// Process any XHR requests to block ad-related requests
function monitorXHR() {
  const originalOpen = XMLHttpRequest.prototype.open;
  
  XMLHttpRequest.prototype.open = function(method, url) {
    if (url) {
      try {
        const urlString = url.toString().toLowerCase();
        if (
          urlString.includes('ad') ||
          urlString.includes('analytics') ||
          urlString.includes('tracker') ||
          urlString.includes('pixel') ||
          urlString.includes('stat.')
        ) {
          chrome.runtime.sendMessage({ action: 'incrementBlockCount' });
          // Return without calling original function to block the request
          return;
        }
      } catch (e) {
        // Continue with the original request if error occurs
      }
    }
    
    // Call the original method for non-ad URLs
    return originalOpen.apply(this, arguments);
  };
}

// Intercept fetch requests to block ad-related requests
function monitorFetch() {
  const originalFetch = window.fetch;
  
  window.fetch = function(resource, init) {
    if (resource) {
      try {
        const url = resource.toString().toLowerCase();
        if (
          url.includes('ad') ||
          url.includes('analytics') ||
          url.includes('tracker') ||
          url.includes('pixel') ||
          url.includes('stat.')
        ) {
          chrome.runtime.sendMessage({ action: 'incrementBlockCount' });
          // Return a resolved promise with empty response to block the request
          return Promise.resolve(new Response(null, { status: 200 }));
        }
      } catch (e) {
        // Continue with the original fetch if error occurs
      }
    }
    
    // Call the original fetch for non-ad URLs
    return originalFetch.apply(window, arguments);
  };
}

// Override window.open to prevent popups
function blockWindowOpen() {
  const originalWindowOpen = window.open;
  
  window.open = function(url, name, features) {
    if (url) {
      try {
        const urlString = url.toString().toLowerCase();
        
        // Check if this is likely an ad URL
        if (isAdURL(urlString) || features && features.includes('popup')) {
          console.log('Blocked popup:', url);
          chrome.runtime.sendMessage({ action: 'incrementBlockCount' });
          return null; // Block the popup by returning null
        }
      } catch (e) {
        // If an error occurs, let the original window.open handle it
      }
    }
    
    // Call original for non-ad URLs
    return originalWindowOpen.apply(window, arguments);
  };
}

// Block popup-related JS APIs
blockWindowOpen();

// Execute our ad blocking as soon as possible
document.addEventListener('DOMContentLoaded', blockAds);

// Also run early to catch ads that load before DOMContentLoaded
blockAds();

// Monitor XHR and fetch requests
monitorXHR();
monitorFetch();