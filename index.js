const https = require('https');
const { parseString } = require('xml2js');

// Configuration
const CONFIG = {
  alcott: {
    name: 'ALCOTT',
    subreddits: [
      // Patient communities
      'ChronicIllness',
      'ADHD', 
      'HealthAnxiety',
      'Caregivers',
      'Autoimmune',
      'CaregiversOfParents',
      'CaregiverSupport',
      // Provider communities
      'medicine',
      'familymedicine',
      'nursepractitioner',
      'residency',
      'Doctorsofreddit',
      'familydocs',
      'FemalePhysicians',
      'HealthcareAdmins',
      'healthIT',
      'medicalschool',
      'PrimaryCare',
      'Orthopedics',
      // Behavioral health
      'therapists',
      'socialwork',
      'psychiatry',
      'counseling',
      // Health system / value-based care
      'healthcare',
      'healthcareworkers',
      'publichealth'
    ],
    keywords: [
      // Visit prep - patient side
      'doctor appointment',
      'appointment anxiety',
      'forget to ask',
      'forgot to ask',
      'never remember',
      'what to ask',
      'prepare for appointment',
      'preparing for appointment',
      'medical visit',
      'overwhelmed at doctor',
      'rushed appointment',
      'didnt understand',
      'didn\'t understand',
      'confused after appointment',
      'health information',
      'medical records',
      'patient portal',
      'test results',
      'lab results',
      'diagnosis overwhelm',
      'visit prep',
      'intake forms',
      // Value-based care
      'care coordination',
      'accountable care',
      'value based care',
      'care management',
      'patient engagement',
      'community health',
      'population health',
      // Patient-side forms frustration (leads to Medipen awareness)
      'doctor won\'t fill out',
      'doctor refused to fill',
      'getting doctor to fill',
      'need forms filled out',
      'doctor to sign forms'
    ]
  },
  medipen: {
    name: 'MEDIPEN',
    subreddits: [
      // Provider communities only
      'medicine',
      'familymedicine',
      'nursepractitioner',
      'residency',
      'Doctorsofreddit',
      'familydocs',
      'FemalePhysicians',
      'HealthcareAdmins',
      'healthIT',
      'medicalschool',
      'PrimaryCare',
      'Orthopedics',
      // Behavioral health
      'therapists',
      'socialwork',
      'psychiatry',
      'counseling',
      // Health system
      'healthcare',
      'healthcareworkers',
      'publichealth'
    ],
    keywords: [
      // Provider-side forms pain
      'disability forms',
      'disability paperwork',
      'disability evaluation',
      'FMLA paperwork',
      'FMLA forms',
      'filling out forms',
      'hate filling out',
      'workers comp forms',
      'workers compensation',
      'short term disability',
      'long term disability',
      'leave paperwork',
      'medical leave forms',
      'functional capacity',
      'work restrictions',
      'return to work forms',
      'filling out disability',
      'UNUM',
      'employer forms',
      'insurance disability',
      'so much paperwork',
      'drowning in paperwork',
      'administrative burden'
    ]
  }
};

// Fetch RSS feed from Reddit
async function fetchRSS(subreddit) {
  return new Promise((resolve, reject) => {
    const url = `https://www.reddit.com/r/${subreddit}/new/.rss`;
    
    const options = {
      headers: {
        'User-Agent': 'aws-lambda:alcott-listener:1.0 (by /u/healthtechnerd)'
      }
    };
    
    https.get(url, options, (res) => {
      let data = '';
      
      // Handle redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        https.get(res.headers.location, options, (redirectRes) => {
          redirectRes.on('data', chunk => data += chunk);
          redirectRes.on('end', () => resolve(data));
        }).on('error', reject);
        return;
      }
      
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to fetch r/${subreddit}: ${res.statusCode}`));
        return;
      }
      
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// Parse RSS XML to posts
async function parseRSS(xml) {
  return new Promise((resolve, reject) => {
    parseString(xml, (err, result) => {
      if (err) {
        reject(err);
        return;
      }
      
      try {
        const entries = result.feed?.entry || [];
        const posts = entries.map(entry => ({
          title: entry.title?.[0] || '',
          link: entry.link?.[0]?.$?.href || '',
          content: entry.content?.[0]?._ || entry.content?.[0] || '',
          author: entry.author?.[0]?.name?.[0] || 'unknown',
          published: entry.published?.[0] || '',
          subreddit: entry.category?.[0]?.$?.term || ''
        }));
        resolve(posts);
      } catch (e) {
        reject(e);
      }
    });
  });
}

// Check if post matches keywords
function matchesKeywords(post, keywords) {
  const text = `${post.title} ${post.content}`.toLowerCase();
  return keywords.filter(keyword => text.includes(keyword.toLowerCase()));
}

// Send Slack notification
async function sendSlackNotification(webhookUrl, message) {
  return new Promise((resolve, reject) => {
    const url = new URL(webhookUrl);
    
    const payload = JSON.stringify(message);
    
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`Slack error: ${res.statusCode} - ${data}`));
        }
      });
    });
    
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Format Slack message
function formatSlackMessage(productName, matches) {
  if (matches.length === 0) {
    return null;
  }
  
  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `🔍 ${productName} — ${matches.length} thread${matches.length > 1 ? 's' : ''} found`,
        emoji: true
      }
    },
    {
      type: 'divider'
    }
  ];
  
  // Limit to top 20 matches
  const topMatches = matches.slice(0, 20);
  
  for (const match of topMatches) {
    const keywordList = match.matchedKeywords.slice(0, 3).join(', ');
    
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*r/${match.subreddit}*\n<${match.link}|${truncate(match.title, 100)}>\n_Keywords: ${keywordList}_`
      }
    });
  }
  
  if (matches.length > 20) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `_...and ${matches.length - 20} more matches_`
        }
      ]
    });
  }
  
  return { blocks };
}

// Truncate text
function truncate(text, maxLength) {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

// Get hours ago timestamp
function getHoursAgo(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

// Main handler
exports.handler = async (event) => {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  const hoursBack = parseInt(process.env.HOURS_BACK || '24', 10);
  
  if (!webhookUrl) {
    throw new Error('SLACK_WEBHOOK_URL environment variable not set');
  }
  
  const cutoffTime = getHoursAgo(hoursBack);
  const allMatches = { alcott: [], medipen: [] };
  
  // Process each product
  for (const [productKey, config] of Object.entries(CONFIG)) {
    console.log(`Processing ${config.name}...`);
    
    for (const subreddit of config.subreddits) {
      try {
        console.log(`  Fetching r/${subreddit}...`);
        const xml = await fetchRSS(subreddit);
        const posts = await parseRSS(xml);
        
        // Filter by time and keywords
        for (const post of posts) {
          const postTime = new Date(post.published);
          if (postTime < cutoffTime) continue;
          
          const matchedKeywords = matchesKeywords(post, config.keywords);
          if (matchedKeywords.length > 0) {
            allMatches[productKey].push({
              ...post,
              subreddit,
              matchedKeywords
            });
          }
        }
        
        // Rate limiting: wait 1 second between requests
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (error) {
        console.error(`  Error fetching r/${subreddit}:`, error.message);
      }
    }
  }
  
  // Send Slack notifications
  const today = new Date().toLocaleDateString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });
  
  let totalMatches = 0;
  
  for (const [productKey, matches] of Object.entries(allMatches)) {
    const config = CONFIG[productKey];
    const message = formatSlackMessage(config.name, matches);
    
    if (message) {
      await sendSlackNotification(webhookUrl, message);
      totalMatches += matches.length;
      console.log(`Sent ${matches.length} matches for ${config.name}`);
    } else {
      console.log(`No matches for ${config.name}`);
    }
  }
  
  // Send summary if no matches at all
  if (totalMatches === 0) {
    await sendSlackNotification(webhookUrl, {
      text: `🔍 Reddit Scan Complete — ${today}\n\nNo matching posts found in the last ${hoursBack} hours.`
    });
  }
  
  return {
    statusCode: 200,
    body: JSON.stringify({
      message: 'Scan complete',
      alcottMatches: allMatches.alcott.length,
      medipenMatches: allMatches.medipen.length
    })
  };
};