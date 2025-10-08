/* eslint-disable no-console */
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const yaml = require('js-yaml');

// ============================================================================
// CONFIGURATION
// ============================================================================

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const POLLINATIONS_TOKEN = process.env.POLLINATIONS_TOKEN || '';
const ZAPIER_WEBHOOK_URL = process.env.ZAPIER_WEBHOOK_URL || '';
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || '';
const OVERRIDE_TOPIC = process.env.OVERRIDE_TOPIC || '';
const OVERRIDE_URL = process.env.OVERRIDE_URL || '';
const SKIP_SOCIAL = process.env.SKIP_SOCIAL === 'true';
const POSTS_DIR = 'Posts';
const IMAGES_DIR = 'public/images/blog';
const BLOG_BASE_URL = 'https://www.limitbreakit.com/insights-news';
const FEATURED_THRESHOLD = 70;
const MIN_WORD_COUNT = 500;
const MIN_SUBHEADINGS = 3;
const EXISTING_POSTS_CACHE = [];
const SCHEDULE_CONFIG_PATH = 'scripts/schedule-config.json';

// ============================================================================
// SCHEDULE CONFIG LOADER
// ============================================================================

async function loadScheduleConfig() {
  try {
    const configData = await fs.readFile(SCHEDULE_CONFIG_PATH, 'utf8');
    const config = JSON.parse(configData);
    return config.scheduled_overrides || [];
  } catch (error) {
    return [];
  }
}

async function checkScheduledOverride() {
  const today = new Date().toISOString().split('T')[0];
  const schedules = await loadScheduleConfig();
  
  const todaySchedule = schedules.find(s => s.date === today);
  
  if (todaySchedule) {
    console.log(`📅  Found scheduled override for ${today}:`);
    
    if (todaySchedule.skip === true) {
      console.log('   Skip: true - Exiting blog generation');
      console.log('\n⏭️  Blog generation skipped for today per schedule configuration');
      process.exit(0);
    }
    
    let override = null;
    
    if (todaySchedule.topic) {
      console.log(`   Topic: "${todaySchedule.topic}"`);
      override = { type: 'topic', value: todaySchedule.topic };
    } else if (todaySchedule.url) {
      console.log(`   URL: "${todaySchedule.url}"`);
      override = { type: 'url', value: todaySchedule.url };
    }
    
    const skipSocial = todaySchedule.skip_social === true;
    if (skipSocial) {
      console.log('   Skip Social: true');
    }
    
    if (override) {
      override.skipSocial = skipSocial;
      return override;
    }
    
    if (skipSocial) {
      return { type: 'skip_social_only' };
    }
    
    console.log('   No specific overrides found, continuing with defaults');
  }
  
  return null;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$|^-$/g, '')
    .substring(0, 60);
}

function stripColons(str = '') {
  return str.replace(/:/g, ' - ');
}

function stripFootnotes(markdown) {
  return markdown.replace(/\[\d{1,4}\]/g, '');
}

function countWords(text) {
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

function validateContent(trend) {
  const errors = [];
  const warnings = [];

  const wordCount = countWords(trend.content);
  if (wordCount < MIN_WORD_COUNT) {
    errors.push(`Content too short: ${wordCount} words (minimum: ${MIN_WORD_COUNT})`);
  }

  const subheadings = (trend.content.match(/^##\s+.+$/gm) || []).length;
  if (subheadings < MIN_SUBHEADINGS) {
    errors.push(`Insufficient structure: ${subheadings} subheadings (minimum: ${MIN_SUBHEADINGS})`);
  }

  const hasDataPoints = /\d+%|\$[\d,]+B?M?|[\d,]+\s+(users|companies|million|billion)/i.test(
    trend.content
  );
  if (!hasDataPoints) {
    warnings.push('Content may lack specific data/statistics');
  }

  const required = ['title', 'slug', 'excerpt', 'content', 'category', 'metaTitle', 'metaDescription'];
  required.forEach(field => {
    if (!trend[field] || trend[field].trim() === '') {
      errors.push(`Missing required field: ${field}`);
    }
  });

  if (typeof trend.trendScore !== 'number' || trend.trendScore < 0 || trend.trendScore > 100) {
    errors.push('Invalid trendScore (must be 0-100)');
  }

  return { errors, warnings, wordCount, subheadings };
}

async function fetchExistingSlugs() {
  const slugs = new Set();
  const posts = [];

  try {
    const files = await fs.readdir(POSTS_DIR);
    const mdFiles = files.filter(f => f.endsWith('.md'));
    
    console.log(`📂  Found ${mdFiles.length} markdown files in ${POSTS_DIR}`);

    const postsWithDates = [];

    for (const file of mdFiles) {
      const slug = file.replace('.md', '');
      slugs.add(slug);

      try {
        const content = await fs.readFile(path.join(POSTS_DIR, file), 'utf8');
        
        const yamlMatch = content.match(/^---\s*\n(.*?)\n---/s);
        if (yamlMatch) {
          try {
            const frontmatter = yaml.load(yamlMatch[1]);
            
            const title = frontmatter.title?.trim();
            const publishedAt = frontmatter.publishedAt;
            
            if (title) {
              postsWithDates.push({
                title,
                publishedAt: publishedAt || '1970-01-01',
                filename: file
              });
            }
          } catch (yamlError) {
            console.warn(`⚠️  Failed to parse YAML in ${file}: ${yamlError.message}`);
            
            const titleMatch = content.match(/^title:\s*(.+)$/m);
            
            if (titleMatch) {
              postsWithDates.push({
                title: titleMatch[1].trim(),
                publishedAt: '1970-01-01',
                filename: file
              });
            }
          }
        } else {
          console.warn(`⚠️  No YAML frontmatter found in ${file}`);
        }
      } catch (err) {
        console.warn(`⚠️  Failed to read ${file}: ${err.message}`);
      }
    }

    postsWithDates.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    
    const recentPosts = postsWithDates.slice(0, 30);
    
    console.log(`📅  Sorted ${postsWithDates.length} posts by date, using latest 30 for duplicate detection`);
    
    if (recentPosts.length > 0) {
      const oldestDate = recentPosts[recentPosts.length - 1].publishedAt;
      const newestDate = recentPosts[0].publishedAt;
      console.log(`   📈  Date range: ${oldestDate} to ${newestDate}`);
    }

    recentPosts.forEach(post => {
      if (post.title) posts.push(post.title);
    });

    console.log(`✓ Found ${mdFiles.length} local posts, extracted ${posts.length} titles from latest 30`);
    
  } catch (error) {
    console.log(`⚠️  Posts directory not found or inaccessible: ${error.message}`);
    return new Set();
  }

  const uniquePosts = [...new Set(posts)]
    .filter(p => p && p.length > 15 && p.length < 150)
    .map(p => p.replace(/\s+/g, ' ').trim());

  EXISTING_POSTS_CACHE.push(...uniquePosts);

  console.log(`✓ Extracted ${uniquePosts.length} unique post titles for duplicate detection`);

  return slugs;
}

// ============================================================================
// AI IMAGE GENERATION
// ============================================================================

async function fetchPollinationsImage(prompt, width, height) {
  const encodedPrompt = encodeURIComponent(prompt);
  let imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=${width}&height=${height}&nologo=true`;
  
  // Add token if available
  if (POLLINATIONS_TOKEN) {
    imageUrl += `&token=${POLLINATIONS_TOKEN}`;
  }
  
  console.log(`   🌐 Generated Pollinations.ai URL`);
  
  return {
    url: imageUrl,
    alt: prompt,
    credit: 'AI Generated Image',
    width,
    height,
    source: 'pollinations'
  };
}

async function fetchAIImage(keywords, category, title, size = 'header', customQuery = null) {
  // Build intelligent prompt
  let basePrompt;
  
  if (customQuery) {
    basePrompt = customQuery;
  } else if (size === 'inline') {
    basePrompt = keywords.slice(1, 4).join(' ') || `${category} technology`;
  } else {
    basePrompt = `${category} technology, ${keywords.slice(0, 2).join(', ')}`;
  }
  
  // Add quality modifiers for better results
  const prompt = `${basePrompt}, professional, modern, high quality, photorealistic, detailed`;
  
  const width = size === 'header' ? 1200 : 800;
  const height = size === 'header' ? 600 : 450;
  
  console.log(`🎨 Generating AI image: "${basePrompt}" (${width}x${height})`);
  
  const result = await fetchPollinationsImage(prompt, width, height);
  
  if (!result) {
    console.warn('⚠️  Image generation failed, using placeholder');
    return {
      url: `/images/blog/placeholder-${size}.jpg`,
      alt: title,
      credit: 'Placeholder Image',
      width,
      height,
      source: 'placeholder'
    };
  }
  
  return result;
}

async function processInlineImages(content, keywords, category, title) {
  const imageTagRegex = /\{\{image:\s*([^,]+),\s*width:\s*(\d+),\s*height:\s*(\d+),\s*alt:\s*"([^"]+)"\}\}/g;
  const matches = [...content.matchAll(imageTagRegex)];
  const imageCredits = [];

  if (matches.length === 0) {
    console.log('ℹ️  No inline image tags found in AI content');
    return { content, credits: imageCredits };
  }

  console.log(`🖼️  Found ${matches.length} inline image tag(s) to process`);

  let updatedContent = content;

  for (const match of matches) {
    const [fullMatch, aiSearchQuery, width, height, alt] = match;
    
    console.log(`🖼️  AI requested image for: "${aiSearchQuery.trim()}"`);

    const imageData = await fetchAIImage(
      keywords,
      category,
      title,
      'inline',
      aiSearchQuery.trim()
    );

    if (imageData) {
      const replacement = `{{image: ${imageData.url}, width: ${width}, height: ${height}, alt: "${alt}"}}`;
      updatedContent = updatedContent.replace(fullMatch, replacement);
      
      imageCredits.push(imageData.credit);
      
      console.log(`✓ Replaced with: ${imageData.url.substring(0, 70)}...`);
    } else {
      console.warn(`⚠️  Could not generate inline image for "${aiSearchQuery.trim()}", removing tag`);
      updatedContent = updatedContent.replace(fullMatch, '');
    }
  }

  return { content: updatedContent, credits: imageCredits };
}

// ============================================================================
// ZAPIER & MAKE.COM WEBHOOKS
// ============================================================================

async function sendToWebhook(webhookUrl, webhookName, blogData, skipSocial = false) {
  if (!webhookUrl) {
    return;
  }

  if (SKIP_SOCIAL || skipSocial) {
    console.log(`⏭️  Skipping ${webhookName} (SKIP_SOCIAL=true or scheduled skip_social)`);
    return;
  }

  console.log(`\n📤  Sending blog data to ${webhookName} for social media processing...`);

  try {
    const formattedHashtags = (blogData.socialMediaHashtags || [])
      .map(tag => tag.startsWith('#') ? tag : `#${tag}`)
      .join(' ');

    const payload = {
      blog_title: blogData.title,
      blog_content: blogData.content,
      blog_url: blogData.url,
      blog_image_url: blogData.imageUrl,
      social_media_hook: blogData.socialMediaHook,
      social_media_key_insight: blogData.socialMediaKeyInsight,
      social_media_why_it_matters: blogData.socialMediaWhyItMatters,
      social_media_hashtags: formattedHashtags
    };

    console.log(`   Title: ${payload.blog_title}`);
    console.log(`   URL: ${payload.blog_url}`);
    console.log(`   Image: ${payload.blog_image_url}`);
    console.log(`   Content length: ${payload.blog_content.length} characters`);
    console.log(`   Social Hook: ${payload.social_media_hook}`);
    console.log(`   Hashtags: ${payload.social_media_hashtags}`);

    const response = await axios.post(webhookUrl, payload, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    if (response.status === 200) {
      console.log(`✅  Successfully sent to ${webhookName} webhook`);
      console.log(`   Response: ${response.data?.status || 'OK'}`);
    }
  } catch (error) {
    console.error(`❌  Failed to send to ${webhookName}:`);
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Message: ${error.response.data?.message || error.message}`);
    } else {
      console.error(`   ${error.message}`);
    }
    console.warn(`⚠️  Continuing despite ${webhookName} error...`);
  }
}

async function sendToZapier(blogData, skipSocial = false) {
  await sendToWebhook(ZAPIER_WEBHOOK_URL, 'Zapier', blogData, skipSocial);
}

async function sendToMake(blogData, skipSocial = false) {
  await sendToWebhook(MAKE_WEBHOOK_URL, 'Make.com', blogData, skipSocial);
}

// ============================================================================
// PERPLEXITY API
// ============================================================================

async function callPerplexity(retryCount = 0, existingTopics = [], override = null, skipSocialGeneration = false) {
  console.log(`🔍  Calling Perplexity… ${retryCount > 0 ? `(Retry ${retryCount}/2)` : ''}`);

  const system = `You are the world's best trending tech blogger. You cover EVERYTHING hot in tech - from devastating cyberattacks to game-changing product launches, from billion-dollar acquisitions to industry-shaking scandals.

Your readers trust you to break down complex tech news into stories they can't stop reading. You write like a journalist at The Verge meets a cybersecurity expert - informed, punchy, and always on top of what's trending RIGHT NOW.

CRITICAL FORMATTING RULES:
- *text* = italic text for subtle emphasis or quotes
- **text** = bold for KEY TERMS, numbers, and important points
- [text](url) = links (when you mention specific products/companies/sources)
- ## Big Header = main section headers
- ### **Subheader** = subsections within main sections
- Tables for comparisons using | markdown syntax
- Bullet points with - for lists
- Never Add **bold** in a ## Big Header

INLINE IMAGE TAGS:
- You CAN and SHOULD add ONE inline image using {{image: search-query, width: 800, height: 450, alt: "description"}} tags
- Place it after the first ## section if the article is 800+ words
- The search-query should be 3-6 DESCRIPTIVE keywords that accurately describe what the image should show
- Be SPECIFIC with your search query - don't use generic terms
- Examples:
  * GOOD: "server room cyberattack red alert" or "folding smartphone curved display"
  * BAD: "technology" or "security" or "innovation"
- Think about what visual would best illustrate your article's main point

FORMATTING REQUIREMENTS:
✓ SHORT paragraphs (2-4 sentences max)
✓ Blank lines between paragraphs
✓ Use **bold** liberally (8-12 times per article)
✓ Use *italics* for quotes or subtle emphasis (3-5 times)
✓ Include 1-2 tables if comparing data/systems/options
✓ Use bullet points for lists of impacts/features/concerns
✓ Include specific numbers with **bold** emphasis

VOICE: 
- Punchy and conversational
- No corporate BS or jargon
- Short, varied sentences
- Write like breaking news to a friend
- Break long sentences into shorter ones - NEVER use em dashes (—)
- Example: Change "Apple released iPhone 17 — a groundbreaking device" to "Apple released iPhone 17. It's a groundbreaking device."

BANNED WORDS: "revolutionize", "game-changer", "cutting-edge", "leverage", "paradigm shift", "synergy", "disruptive", "stakeholders", "utilize", "robust", "seamless", "transformative"

YAML HEADER RULES:
- NEVER use colons (:) in any YAML values
- Replace colons with dashes (-)
- Keep titles under 65 characters
- Excerpts must be 140-160 characters

Return ONLY valid JSON (no markdown code blocks, no backticks, just pure JSON starting with { and ending with }).`;

  const existingTopicsList = existingTopics.length > 0 
    ? `\n\nEXISTING BLOG POSTS (DO NOT duplicate these topics or angles):\n${existingTopics.slice(0, 50).map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\nCRITICAL DUPLICATE DETECTION:\n- Use fuzzy matching to detect duplicates even if titles differ slightly\n- Example: "Meta Glasses" vs "Meta's $799 Smart Glasses" = DUPLICATE\n- If your chosen topic is even remotely similar to anything above, PICK SOMETHING ELSE\n- Check for overlap in: companies mentioned, technology type, or incident type`
    : '';

  let userPrompt;

  if (override && override.type === 'topic') {
    userPrompt = `Write a comprehensive blog post about this specific topic: "${override.value}"${existingTopicsList}

CRITICAL RESEARCH REQUIREMENTS:
- Research the LATEST developments about "${override.value}"
- Find TECHNICAL DETAILS and specific information
- Look for recent news articles, technical blogs, official announcements
- YOU MUST cite at least 2 credible sources
- If technical details aren't available, explicitly state "Technical details not yet disclosed"
- NEVER fabricate numbers or facts`;

  } else if (override && override.type === 'url') {
    userPrompt = `Read this article and write a comprehensive blog post based on it: ${override.value}${existingTopicsList}

CRITICAL REQUIREMENTS:
- Fetch and READ the content from the URL provided
- Write your own unique take with additional research and context
- YOU MUST cite the original article as a source
- Add at least 1 more credible source for additional context
- Expand on the topic with technical details and implications`;

  } else {
    userPrompt = `Find the HOTTEST tech story from the past 48 hours that would make people stop scrolling. This needs to be genuinely trending - something people are actively talking about RIGHT NOW.${existingTopicsList}

CRITICAL RESEARCH REQUIREMENTS:
- Search for TECHNICAL DETAILS and specific attack vectors - don't just summarize press releases
- Look for security researcher reports, CVE databases, technical blogs (Krebs, BleepingComputer, SecurityWeek)
- If it's a cyberattack, find out HOW they got in (specific vulnerability, which system, which CVE)
- YOU MUST cite at least 2 sources: one technical source AND one mainstream outlet
- If technical details aren't available, explicitly write "Technical details not yet disclosed" - DO NOT speculate
- If a specific number (users affected, dollar amount, CVE ID) cannot be confirmed, write "Data not yet available" - NEVER fabricate numbers

WHAT MAKES A STORY HOT:
✅ **Cyberattacks** - Especially ones hitting major companies, infrastructure, or millions of users
✅ **Major product launches** - New iPhones, groundbreaking AI models, game-changing hardware
✅ **Tech scandals** - Data breaches, CEO drama, company meltdowns, whistleblowers
✅ **Billion-dollar moves** - Acquisitions, funding rounds, market crashes, bankruptcies
✅ **Infrastructure failures** - Major outages (AWS, Google, Microsoft, etc.), system crashes
✅ **AI breakthroughs or disasters** - New capabilities that shock people OR spectacular failures
✅ **Regulatory bombshells** - Governments banning things, massive fines, legal battles
✅ **Industry drama** - Layoffs, pivots, competitive battles, market shake-ups

AVOID BORING STUFF:
❌ Minor feature updates or version bumps
❌ Routine earnings (unless there's drama)
❌ Generic trend pieces without specific news
❌ Press releases without substance`;
  }

  userPrompt += `

AI REASONING FOR METADATA:

You must intelligently decide ALL metadata fields using reasoning:

**featuredDecision**: Evaluate if this story deserves featured status (true/false) based on:
- Trending score (70+ = likely featured)
- Impact scope (affects millions of users = featured)
- Breaking news value (happening RIGHT NOW = featured)
- Industry significance (reshapes markets = featured)
Provide your reasoning in "featuredReasoning" field.

**category**: Choose the BEST fit from these recommended categories:
- Artificial Intelligence
- Cybersecurity
- Cloud & Infrastructure
- Digital Transformation
- Data Protection
- Innovation & Emerging Tech
- DevOps & Development
- Business Technology

If none of these fit perfectly, you MAY create a new category that better matches the article's focus.
Explain your choice in "categoryReasoning" field.

**tags**: Generate 3-5 highly specific, searchable tags (not generic ones like "technology")
Examples: "Airport Hack", "ChatGPT-5", "AWS Outage", "Apple M5 Chip"

**trendScore**: Rate 0-100 based on:
- Search volume and social media buzz
- Relevance to tech professionals and businesses  
- Long-term significance vs flash-in-pan news
- Number of major outlets covering it
Be honest and conservative - not everything is 90+.

WRITING INSTRUCTIONS:

Write 1000+ words. SHORT paragraphs (2-4 sentences). Blank lines between ALL paragraphs.

**Opening** (2-4 sentences, no heading)
Start with a BANG. Lead with the most shocking fact or angle.

GOOD: "**Heathrow Airport** went dark yesterday. Not a power failure - a cyberattack that grounded **thousands of flights** across Europe."
BAD: "A significant security incident affected major airports..."

Create 4-5 sections with ## headers. Choose headers that fit YOUR specific story - don't use generic templates. Make headers compelling and specific to the news.

INLINE IMAGE PLACEMENT (IMPORTANT):
If your article is 800+ words, add ONE inline image tag after the first ## section.
Think carefully about what visual would best illustrate the story:

For a cyberattack story:
{{image: ransomware attack command center screen, width: 800, height: 450, alt: "Cybersecurity operations center"}}

For a product launch:
{{image: foldable smartphone unfolding display, width: 800, height: 450, alt: "Advanced smartphone technology"}}

For a data breach:
{{image: hacked database server warning lights, width: 800, height: 450, alt: "Data breach security alert"}}

BE SPECIFIC with your search query - generic terms like "technology" or "security" won't work well.

STRUCTURE GUIDELINES (adapt to your story):

For CYBERATTACK stories:
- Section 1: The attack details (what happened, when, who's affected)
- Section 2: The damage and scope (numbers, impact, victims)
- Section 3: How they did it (technical breakdown - ONLY if details are public)
- Section 4: What's at risk / what happens next
- Final: Practical takeaway

For PRODUCT LAUNCH stories:
- Section 1: What's new and why it's big
- Section 2: The technology explained
- Section 3: Market impact / competition angle
- Section 4: What this means for users/businesses
- Final: Bottom line

For BUSINESS/FUNDING stories:
- Section 1: The deal details
- Section 2: Why this matters / market context
- Section 3: What they're building / the vision
- Section 4: Winners and losers / competitive landscape
- Final: What to watch

**Final section** (100-150 words)
Start with "Bottom line:" or "Here's what matters:"
*Put your key takeaway in italics as a full sentence.*`;

  if (!skipSocialGeneration) {
    userPrompt += `

SOCIAL MEDIA POST GENERATION:

You must also create ONE social media post suitable for LinkedIn, Facebook, and Instagram that adheres to the following requirements:

REQUIREMENTS:
- Length: 300-450 characters (ensuring readability across all platforms)
- Tone: Use same tone as blog
- Make it easy to understand for all people, Don't use complicated wording
- Start with a compelling hook: a shocking statistic, a thought-provoking question, or a bold statement
- Follow with 2-3 concise sentences that explain the key insight
- Incorporate 1-2 professional emojis naturally (options: 🚨 💡 📊 ⚡ 🔥)
- Do not use em-dashes
- Generate 4-5 relevant hashtags that mix professional and trending topics

FORMAT:
[Hook with emoji]
[Key insight - 1-2 sentences]
[Why it matters - 1 sentence]
[Hashtags]

TONE EXAMPLES:
✅ "🚨 50,000 companies just got exposed. Here's what happened..."
✅ "This one security flaw could cost you everything 💡"
❌ "We are pleased to announce..." (too corporate)
❌ "OMG you won't believe this!!!" (too casual)

CRITICAL: Break down your social media post into these specific fields:
- "socialMediaHook": The opening hook with emoji (1-2 sentences)
- "socialMediaKeyInsight": The key insight explanation (1-2 sentences)
- "socialMediaWhyItMatters": Why this matters (1 sentence)
- "socialMediaHashtags": Array of 4-5 hashtags (without # symbol, just the text)`;
  } else {
    userPrompt += `

SOCIAL MEDIA POST SKIPPED:
- Do NOT generate social media fields as they will not be used
- Focus only on the blog content and metadata`;
  }

  userPrompt += `

COMPLETE JSON RESPONSE:

{
  "title": "Keyword-rich title (50-65 chars, NO COLONS, include primary keyword)",
  "slug": "url-friendly-slug-with-primary-keyword",
  "excerpt": "Compelling hook with primary keyword (140-160 chars, NO COLONS)",
  "content": "Full markdown article - MUST include ONE {{image:...}} tag if 800+ words",
  "category": "Your chosen category",
  "categoryReasoning": "Brief explanation of why this category fits best",
  "tags": ["Specific", "Searchable", "Tags", "Like iPhone17", "Not Generic"],
  "featured": true or false,
  "featuredReasoning": "Why this deserves featured status or not",
  "metaTitle": "SEO title with primary keyword (50-60 chars, NO COLONS)",
  "metaDescription": "Benefit/hook with primary keyword (150-160 chars, NO COLONS)",
  "keywords": ["primary-keyword-phrase", "secondary-keyword", "long-tail-search-phrase"],
  "image": "/images/blog/descriptive-file-name.jpg",
  "author": "Marco Grima",
  "trendScore": 75,
  "sources": "Mention 1-2 credible sources (e.g., 'The Verge, Bloomberg')"${!skipSocialGeneration ? `,
  "socialMediaHook": "🚨 Compelling hook with emoji that grabs attention",
  "socialMediaKeyInsight": "1-2 sentences explaining the key insight in simple terms",
  "socialMediaWhyItMatters": "One sentence explaining why this matters to the reader",
  "socialMediaHashtags": ["Hashtag1", "Hashtag2", "Hashtag3", "Hashtag4", "Hashtag5"]` : ''}
}

🚨 CRITICAL: Return ONLY the JSON object. No markdown wrappers. No backticks. No commentary. Just pure JSON starting with { and ending with }.`;

  try {
    console.log('\n' + '='.repeat(80));
    console.log('📤  SYSTEM PROMPT BEING SENT TO PERPLEXITY:');
    console.log('='.repeat(80));
    console.log(system);
    console.log('\n' + '='.repeat(80));
    console.log('📤  USER PROMPT BEING SENT TO PERPLEXITY:');
    console.log('='.repeat(80));
    console.log(userPrompt);
    console.log('='.repeat(80) + '\n');

    const { data } = await axios.post(
      'https://api.perplexity.ai/chat/completions',
      {
        model: 'sonar-reasoning-pro',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.7,
        max_tokens: 8000
      },
      {
        headers: {
          'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 90000
      }
    );

    let raw = data?.choices?.[0]?.message?.content?.trim() || '{}';

    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    
    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
      raw = raw.substring(jsonStart, jsonEnd + 1);
    }

    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/g, '').trim();

    const result = JSON.parse(raw);

    const wordCount = countWords(result.content || '');
    const subheadings = (result.content?.match(/^##\s+.+$/gm) || []).length;

    if (wordCount < MIN_WORD_COUNT || subheadings < MIN_SUBHEADINGS) {
      if (retryCount < 3) {
        const waitTime = 2000 * Math.pow(2, retryCount);
        console.warn(`⚠️  Response inadequate (${wordCount} words, ${subheadings} subheadings). Retrying in ${waitTime/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        return callPerplexity(retryCount + 1, existingTopics, override, skipSocialGeneration);
      }
    }

    return result;
  } catch (error) {
    console.error(`❌ API Error (attempt ${retryCount + 1}/3):`, error.response?.status || error.message);

    if (retryCount < 3) {
      const waitTime = 2000 * Math.pow(2, retryCount);
      console.log(`⏳ Retrying in ${waitTime/1000}s...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return callPerplexity(retryCount + 1, existingTopics, override, skipSocialGeneration);
    }

    throw error;
  }
}

// ============================================================================
// MAIN GENERATION LOGIC
// ============================================================================

async function generateBlog() {
  console.log('🚀  Starting blog generation...\n');

  let override = null;
  let skipSocial = SKIP_SOCIAL;

  if (OVERRIDE_TOPIC) {
    override = { type: 'topic', value: OVERRIDE_TOPIC };
    console.log(`🎯  Manual topic override: "${OVERRIDE_TOPIC}"\n`);
  } else if (OVERRIDE_URL) {
    override = { type: 'url', value: OVERRIDE_URL };
    console.log(`🎯  Manual URL override: "${OVERRIDE_URL}"\n`);
  } else {
    override = await checkScheduledOverride();
    if (override) {
      if (override.type === 'skip_social_only') {
        skipSocial = true;
        override = null;
      } else if (override.skipSocial) {
        skipSocial = true;
      }
    }
  }

  if (skipSocial) {
    console.log('⏭️  Social media posting is DISABLED for this run\n');
  }

  console.log('📚  Checking existing blog posts...');
  const existing = await fetchExistingSlugs();
  console.log(`✓ Found ${EXISTING_POSTS_CACHE.length} existing posts to avoid duplicating\n`);

  const trend = await callPerplexity(0, EXISTING_POSTS_CACHE, override, skipSocial);
  console.log(`📰  Received: "${trend.title}"`);

  const validation = validateContent(trend);

  if (validation.errors.length > 0) {
    console.error('\n❌  VALIDATION FAILED:');
    validation.errors.forEach(err => console.error(`   - ${err}`));
    process.exit(1);
  }

  if (validation.warnings.length > 0) {
    console.warn('\n⚠️  WARNINGS:');
    validation.warnings.forEach(warn => console.warn(`   - ${warn}`));
  }

  console.log(`\n✓ Content validated: ${validation.wordCount} words, ${validation.subheadings} sections`);

  const featured = trend.featured === true || Number(trend.trendScore || 0) >= FEATURED_THRESHOLD;
  console.log(`✓ Trend score: ${trend.trendScore}/100`);
  console.log(`✓ Featured: ${featured ? 'YES' : 'NO'}`);
  if (trend.featuredReasoning) {
    console.log(`  Reasoning: ${trend.featuredReasoning}`);
  }
  if (trend.categoryReasoning) {
    console.log(`✓ Category: ${trend.category} (${trend.categoryReasoning})`);
  }

  ['title', 'excerpt', 'metaTitle', 'metaDescription'].forEach(k => {
    if (trend[k]) {
      trend[k] = stripColons(trend[k]);
    }
  });

  let slug = trend.slug || slugify(trend.title);
  if (existing.has(slug)) {
    const randomSuffix = (Math.random() + 1).toString(36).substring(2, 8);
    slug = `${slug}-${randomSuffix}`;
    console.log(`⚠️  Slug collision detected, using: ${slug}`);
  }

  let imageUrl = null;
  let rawImageUrl = null;
  let imageCredit = null;

  console.log('\n🖼️  Generating blog header image (1200x600)...');
  const imageData = await fetchAIImage(
    trend.keywords || [],
    trend.category,
    trend.title,
    'header'
  );

  if (imageData) {
    imageUrl = imageData.url;
    rawImageUrl = imageData.url;
    imageCredit = imageData.credit;
    console.log(`✓ Header image: ${imageUrl.substring(0, 80)}...`);
  } else {
    console.warn('⚠️  Could not generate header image');
    imageUrl = `/images/blog/${slug}.jpg`;
    rawImageUrl = imageUrl;
  }

  let content = stripFootnotes(trend.content || '');

  console.log('\n🖼️  Processing inline images...');
  const { content: processedContent, credits: inlineImageCredits } = await processInlineImages(
    content, 
    trend.keywords || [], 
    trend.category, 
    trend.title
  );
  content = processedContent;

  const allCredits = [imageCredit, ...inlineImageCredits].filter(Boolean);
  if (allCredits.length > 0) {
    const creditText = allCredits.join(' | ');
    content += `\n\n---\n\n*${creditText}*`;
  }

  const frontmatter = {
    slug,
    title: trend.title,
    excerpt: trend.excerpt,
    publishedAt: new Date().toISOString().split('T')[0],
    author: 'Marco Grima',
    category: trend.category || 'Innovation',
    tags: trend.tags || [],
    image: imageUrl,
    featured,
    metaTitle: trend.metaTitle || trend.title,
    metaDescription: trend.metaDescription || trend.excerpt,
    keywords: trend.keywords || []
  };

  const yamlFront = yaml.dump(frontmatter, {
    lineWidth: -1,
    quotingType: '"',
    forceQuotes: false
  });

  const finalMd = `---\n${yamlFront}---\n\n${content}`;

  await fs.mkdir(POSTS_DIR, { recursive: true });
  const filePath = path.join(POSTS_DIR, `${slug}.md`);
  await fs.writeFile(filePath, finalMd, 'utf8');

  console.log(`\n✅  Blog post successfully saved!`);
  console.log(`📁  Location: ${filePath}`);
  console.log(`👤  Author: Marco Grima`);
  console.log(`🏷️   Category: ${frontmatter.category}`);
  console.log(`🔖  Tags: ${frontmatter.tags.join(', ')}`);
  console.log(`🖼️  Header image: ${imageUrl.substring(0, 80)}...`);
  console.log(`${featured ? '⭐  Featured post' : '📌  Standard post'}`);

  if (!skipSocial) {
    const blogData = {
      title: trend.title,
      content: content,
      url: `${BLOG_BASE_URL}/${slug}`,
      imageUrl: rawImageUrl,
      socialMediaHook: trend.socialMediaHook || '',
      socialMediaKeyInsight: trend.socialMediaKeyInsight || '',
      socialMediaWhyItMatters: trend.socialMediaWhyItMatters || '',
      socialMediaHashtags: trend.socialMediaHashtags || []
    };

    await sendToZapier(blogData, false);
    await sendToMake(blogData, false);
  } else {
    console.log('\n⏭️  Skipped social media webhooks (social media disabled)');
  }

  return {
    slug,
    title: trend.title,
    url: `${BLOG_BASE_URL}/${slug}`
  };
}

// ============================================================================
// EXECUTION
// ============================================================================

(async () => {
  try {
    if (!PERPLEXITY_API_KEY) {
      throw new Error('PERPLEXITY_API_KEY environment variable is not set');
    }

    console.log('🎨 AI Image Generation Configuration:');
    console.log('   Using: Pollinations.ai (free, unlimited)');
    
    if (POLLINATIONS_TOKEN) {
      console.log('   ✓ POLLINATIONS_TOKEN configured');
    } else {
      console.warn('   ⚠️  POLLINATIONS_TOKEN not set - using default (may have rate limits)');
    }
    console.log('');

    if (!ZAPIER_WEBHOOK_URL && !MAKE_WEBHOOK_URL && !SKIP_SOCIAL) {
      console.warn('⚠️  No webhook URLs configured (ZAPIER_WEBHOOK_URL or MAKE_WEBHOOK_URL)');
      console.warn('   Social media data will not be sent to any automation platform\n');
    } else if (!SKIP_SOCIAL) {
      if (ZAPIER_WEBHOOK_URL) {
        console.log('✓ Zapier webhook configured');
      }
      if (MAKE_WEBHOOK_URL) {
        console.log('✓ Make.com webhook configured');
      }
      console.log('');
    }

    const result = await generateBlog();
    console.log('\n🎉  Generation complete!');
    console.log(`📝  Blog URL: ${result.url}\n`);
  } catch (error) {
    console.error('\n💥  Generation failed:');
    console.error(error.message);
    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
})();
