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
      // Patient-side forms frustration
      'doctor won\'t fill out',
      'doctor refused to fill',
      'getting doctor to fill',
      'need forms filled out',
      'doctor to sign forms'
    ]
  }
};

// ============================================================
// Reply Drafter System Prompt (distilled from SKILL.md)
// ============================================================

const DRAFTER_SYSTEM_PROMPT = `You are Healthtech_Nerd on Reddit. You are a health tech nerd, NOT a clinician. You understand clinical workflows deeply but never impersonate medical staff.

Your job: draft a Reddit reply to the thread provided. Follow these rules exactly.

VOICE:
- Warm, empathetic, conversational. First-person. Genuinely curious.
- Use contractions (don't, isn't, won't, it's)
- Mix of short and medium sentences. Paragraph breaks between thoughts.
- Frame your knowledge as "I work in health tech" or "I nerd out in this space"

STRUCTURE (make it feel natural, not formulaic):
1. Empathize/validate (1-2 sentences) - acknowledge their situation. Lead with empathy or shared experience.
2. Share knowledge/experience (2-5 sentences) - specific, practical, actionable. Reference details from their post.
3. Ask a genuine follow-up question (1 sentence) - specific to something they mentioned.

NEVER USE:
- Em dashes (—) anywhere, ever. Use commas, periods, or parentheses instead.
- "Great question!" / "Thanks for sharing!"
- "I'd be happy to help" / "Feel free to reach out"
- "Our product" / "Our solution" / "Our platform"
- Emoji
- "DM me"
- Marketing language: "solution," "leverage," "empower," "streamline," "unlock," "game-changer," "revolutionary"
- Bold text, headers, numbered lists, or other formatting. Just plain conversational text.

TWO-TOUCH RULE:
- The FIRST reply is ALWAYS pure value. Zero product mentions. No exceptions.
- Also draft a FOLLOW-UP reply template that would only be posted if the OP engages back. This follow-up can casually mention Alcott if relevant.
- If the thread doesn't warrant a product mention at all, skip the follow-up.

PRODUCT CONTEXT (for follow-up only):
Alcott: patient-facing visit prep, care coordination, patient engagement. $249/mo for up to 5 clinicians. Not a full EHR. When mentioning, be transparent about what it is and isn't. Casual close: "Let me know if you'd like to chat, happy to connect."

OUTPUT FORMAT:
Return a JSON object with this exact structure:
{
  "first_reply": "the Strategy A reply text (pure value, no product)",
  "follow_up": "the Strategy B reply template (with casual product mention), or null if not applicable",
  "strategy_note": "brief explanation of why you chose this approach"
}

Return ONLY the JSON object, no markdown fences, no extra text.`;

// ============================================================
// Claude API Integration
// ============================================================

async function draftReply(post) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const userMessage = `Draft a Reddit reply to this thread.

Subreddit: r/${post.subreddit}
Title: ${post.title}
Content: ${stripHtml(post.content)}
Matched Keywords: ${post.matchedKeywords.join(', ')}`;

  const body = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: DRAFTER_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }]
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.content && parsed.content[0]) {
            const text = parsed.content[0].text;
            // Parse the JSON response from Claude
            const draft = JSON.parse(text);
            resolve(draft);
          } else {
            console.error('Unexpected Claude response:', data);
            resolve(null);
          }
        } catch (e) {
          console.error('Failed to parse Claude response:', e.message);
          resolve(null);
        }
      });
    });

    req.on('error', (e) => {
      console.error('Claude API error:', e.message);
      resolve(null); // Don't break the Lambda on draft failure
    });

    req.write(body);
    req.end();
  });
}

// Strip HTML tags from RSS content
function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 2000); // Cap length for API call
}

// ============================================================
// RSS Feed Monitoring
// ============================================================

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

function matchesKeywords(post, keywords) {
  const text = `${post.title} ${post.content}`.toLowerCase();
  return keywords.filter(keyword => text.includes(keyword.toLowerCase()));
}

// ============================================================
// Slack Notifications
// ============================================================

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

// Format Slack message with draft replies included
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
    { type: 'divider' }
  ];

  const topMatches = matches.slice(0, 10); // Reduced from 20 since drafts take more space

  for (const match of topMatches) {
    const keywordList = match.matchedKeywords.slice(0, 3).join(', ');

    // Thread info
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*r/${match.subreddit}*\n<${match.link}|${truncate(match.title, 100)}>\n_Keywords: ${keywordList}_`
      }
    });

    // Draft reply (if available)
    if (match.draft) {
      blocks.push({
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `📝 _${match.draft.strategy_note}_`
        }]
      });
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Draft reply:*\n${truncate(match.draft.first_reply, 500)}`
        }
      });

      if (match.draft.follow_up) {
        blocks.push({
          type: 'context',
          elements: [{
            type: 'mrkdwn',
            text: `💬 *Follow-up (if they reply):* ${truncate(match.draft.follow_up, 300)}`
          }]
        });
      }

      blocks.push({ type: 'divider' });
    }
  }

  if (matches.length > 10) {
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `_...and ${matches.length - 10} more matches (drafts generated for top 10 only)_`
      }]
    });
  }

  return { blocks };
}

// ============================================================
// Helpers
// ============================================================

function truncate(text, maxLength) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

function getHoursAgo(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

// ============================================================
// Main Handler
// ============================================================

exports.handler = async (event) => {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  const hoursBack = parseInt(process.env.HOURS_BACK || '24', 10);
  const draftsEnabled = !!process.env.ANTHROPIC_API_KEY;

  if (!webhookUrl) {
    throw new Error('SLACK_WEBHOOK_URL environment variable not set');
  }

  const cutoffTime = getHoursAgo(hoursBack);
  const allMatches = { alcott: [] };

  // ---- Step 1: Scan subreddits for matching threads ----

  for (const [productKey, config] of Object.entries(CONFIG)) {
    console.log(`Processing ${config.name}...`);

    for (const subreddit of config.subreddits) {
      try {
        console.log(`  Fetching r/${subreddit}...`);
        const xml = await fetchRSS(subreddit);
        const posts = await parseRSS(xml);

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

        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (error) {
        console.error(`  Error fetching r/${subreddit}:`, error.message);
      }
    }
  }

  // ---- Step 2: Generate draft replies for top matches ----

  if (draftsEnabled) {
    for (const [productKey, matches] of Object.entries(allMatches)) {
      // Draft replies for top 10 matches to manage API costs
      const toDraft = matches.slice(0, 10);
      console.log(`Drafting replies for ${toDraft.length} matches...`);

      for (const match of toDraft) {
        try {
          console.log(`  Drafting reply for: ${truncate(match.title, 50)}`);
          match.draft = await draftReply(match);

          // Brief pause between API calls
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          console.error(`  Error drafting reply:`, error.message);
          match.draft = null;
        }
      }
    }
  } else {
    console.log('ANTHROPIC_API_KEY not set, skipping draft generation');
  }

  // ---- Step 3: Send Slack notifications ----

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
      draftsGenerated: draftsEnabled ? allMatches.alcott.filter(m => m.draft).length : 0
    })
  };
};
