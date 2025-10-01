/* eslint-disable no-console */
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const yaml = require('js-yaml');

// ============================================================================
// CONFIGURATION
// ============================================================================

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const POSTS_DIR = 'Posts';
const BLOG_BASE_URL = 'https://www.limitbreakit.com/insights-news';
const FEATURED_THRESHOLD = 70; // AI will decide featured status based on reasoning
const MIN_WORD_COUNT = 500;
const MIN_SUBHEADINGS = 3;
const EXISTING_POSTS_CACHE = []; // Will store titles/topics from website

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

  // Method 1: Read local Posts directory
  try {
    const files = await fs.readdir(POSTS_DIR);
    for (const file of files.filter(f => f.endsWith('.md'))) {
      const slug = file.replace('.md', '');
      slugs.add(slug);
      
      try {
        const content = await fs.readFile(path.join(POSTS_DIR, file), 'utf8');
        
        // Extract title from frontmatter
        const titleMatch = content.match(/^title:\s*(.+)$/m);
        if (titleMatch) {
          posts.push(titleMatch[1].trim());
        }
        
        // Also extract keywords and tags to get better topic coverage
        const excerptMatch = content.match(/^excerpt:\s*(.+)$/m);
        if (excerptMatch) {
          posts.push(excerptMatch[1].trim());
        }
      } catch (err) {
        console.warn(`⚠️  Failed to read ${file}: ${err.message}`);
      }
    }
    console.log(`✓ Found ${files.length} local posts`);
  } catch (_) {
    console.log('⚠️  Posts directory not found - checking website only');
  }

  // Method 2: Scrape website blog list
  try {
    const { data: html } = await axios.get(BLOG_BASE_URL, { timeout: 15000 });
    
    // Extract slugs from links
    const slugMatches = html.match(/\/insights-news\/([a-z0-9-]+)/g) || [];
    slugMatches.forEach(match => {
      const slug = match.split('/').pop();
      if (slug && slug.length > 5) slugs.add(slug);
    });
    
    // Try multiple methods to extract titles
    // Method A: Look for article titles in various HTML structures
    const titlePatterns = [
      /<h[1-4][^>]*class="[^"]*title[^"]*"[^>]*>([^<]+)<\/h[1-4]>/gi,
      /<h[1-4][^>]*>([^<]{20,120})<\/h[1-4]>/g,
      /<a[^>]*href="\/insights-news\/[^"]*"[^>]*>([^<]{20,120})<\/a>/g,
      /<span[^>]*class="[^"]*title[^"]*"[^>]*>([^<]+)<\/span>/gi,
      /<div[^>]*class="[^"]*title[^"]*"[^>]*>([^<]+)<\/div>/gi
    ];
    
    titlePatterns.forEach(pattern => {
      const matches = html.matchAll(pattern);
      for (const match of matches) {
        const title = match[1].replace(/\s+/g, ' ').trim();
        if (title.length > 15 && title.length < 150) {
          posts.push(title);
        }
      }
    });
    
    // Method B: Extract from JSON-LD if present
    const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>(.*?)<\/script>/s);
    if (jsonLdMatch) {
      try {
        const jsonData = JSON.parse(jsonLdMatch[1]);
        if (jsonData.headline) posts.push(jsonData.headline);
        if (jsonData.name) posts.push(jsonData.name);
        if (Array.isArray(jsonData)) {
          jsonData.forEach(item => {
            if (item.headline) posts.push(item.headline);
            if (item.name) posts.push(item.name);
          });
        }
      } catch (_) {}
    }
    
    console.log(`✓ Found ${slugMatches.length} remote slugs`);
  } catch (err) {
    console.warn(`⚠️  Could not fetch website: ${err.message}`);
  }

  // Deduplicate and clean posts
  const uniquePosts = [...new Set(posts)]
    .filter(p => p.length > 15 && p.length < 150)
    .map(p => p.replace(/\s+/g, ' ').trim());
  
  EXISTING_POSTS_CACHE.push(...uniquePosts);
  
  console.log(`✓ Extracted ${uniquePosts.length} unique post topics for duplicate detection`);
  
  return slugs;
}

function injectMidImage(md) {
  const words = md.split(/\s+/);
  if (words.length < 800) return md;

  const idx = md.indexOf('##');
  if (idx === -1) return md;
  const firstH2 = md.indexOf('\n', idx);
  if (firstH2 === -1) return md;

  const imgTag = '\n\n{{image: /images/blog/ai-tools-comparison-chart.jpg, width: 600, height: 400, alt: "Comparison of AI creative tools"}}\n';
  return md.slice(0, firstH2 + 1) + imgTag + md.slice(firstH2 + 1);
}

// ============================================================================
// PERPLEXITY API
// ============================================================================

async function callPerplexity(retryCount = 0, existingTopics = []) {
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
- {{image: /images/blog/descriptive-name.jpg, width: 600, height: 400, alt: "Description"}} = inline images after major sections

FORMATTING REQUIREMENTS:
✓ SHORT paragraphs (2-4 sentences max)
✓ Blank lines between paragraphs
✓ Use **bold** liberally (8-12 times per article)
✓ Use *italics* for quotes or subtle emphasis (3-5 times)
✓ Include 1-2 tables if comparing data/systems/options
✓ Add 1-2 inline images using {{image:...}} syntax
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

Return ONLY valid JSON (no markdown wrappers).`;

  const existingTopicsList = existingTopics.length > 0 
    ? `\n\nEXISTING BLOG POSTS (DO NOT duplicate these topics or angles):\n${existingTopics.slice(0, 50).map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\nCRITICAL: You MUST choose a COMPLETELY DIFFERENT story. Check if your chosen topic is similar to any above. If it overlaps in subject matter, pick something else.`
    : '';

  const user = `Find the HOTTEST tech story from the past 48 hours that would make people stop scrolling. This needs to be genuinely trending - something people are actively talking about RIGHT NOW.

DUPLICATE CHECK: Before finalizing your choice, verify it's NOT covered in the existing posts list below. If the topic is similar or overlaps, CHOOSE A DIFFERENT STORY.${existingTopicsList}

CRITICAL RESEARCH REQUIREMENTS:
- Search for TECHNICAL DETAILS and specific attack vectors - don't just summarize press releases
- Look for security researcher reports, CVE databases, technical blogs (Krebs, BleepingComputer, SecurityWeek)
- If it's a cyberattack, find out HOW they got in (specific vulnerability, which system, which CVE)
- Cite SPECIFIC technical sources, not just mainstream news
- If technical details aren't available, explicitly state "Technical details not yet disclosed" - DO NOT speculate

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
❌ Press releases without substance${existingTopicsList}

AI REASONING FOR METADATA:

You must intelligently decide ALL metadata fields using reasoning:

**featuredDecision**: Evaluate if this story deserves featured status (true/false) based on:
- Trending score (70+ = likely featured)
- Impact scope (affects millions of users = featured)
- Breaking news value (happening RIGHT NOW = featured)
- Industry significance (reshapes markets = featured)
Provide your reasoning in "featuredReasoning" field.

**category**: Choose the BEST fit from: Cybersecurity, AI, Cloud, DevOps, Innovation, Digital Transformation
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

For a cyberattack story, headers might be:
- ## The Attack That Shut Down Europe's Busiest Airport
- ## Why Airport Security Just Got a Wake-Up Call
- ## How Hackers Exploited a Single Weakness
- ## What Every Business Should Do Today

For a product launch, headers might be:
- ## Apple's Biggest Bet Since the iPhone
- ## The Technology That Changes Everything
- ## Why Competitors Are Scrambling
- ## What This Means for Your Business

STRUCTURE EACH SECTION:

IMPORTANT: Do NOT follow a rigid template. Adapt your structure to fit the story. Not every article needs a table or image in the same place. Be flexible and natural.

**Opening paragraph** (2-4 sentences, no heading)
Lead with the most shocking fact. Make it punchy and specific to this story.

**Create 4-5 sections with compelling ## headers**
Headers should be specific to YOUR story, not generic. Make readers curious.

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

FORMATTING FLEXIBILITY:

**Images**: Add 1 image where it makes sense visually - usually after first or second section, NOT always in the same spot. Skip if story doesn't need it.

**Tables**: Only use if you're comparing data, systems, or options. Many stories don't need tables - don't force it.

**Bullet points**: Use when listing multiple impacts, features, or concerns. But also use regular paragraphs when appropriate.

**Subsections (###)**: Rarely needed. Only use if a section is genuinely complex and needs breaking down.

**Length per section**: 200-300 words is a guideline, not a rule. Some sections might be 150 words, others 350. Let the content dictate length.

**Final section** (100-150 words)
Start with "Bottom line:" or "Here's what matters:"
*Put your key takeaway in italics as a full sentence.*

BE NATURAL. Don't robotically follow templates. Every story is different - write accordingly.

COMPLETE JSON RESPONSE:

{
  "title": "Keyword-rich title (50-65 chars, NO COLONS, include primary keyword)",
  "slug": "url-friendly-slug-with-primary-keyword",
  "excerpt": "Compelling hook with primary keyword (140-160 chars, NO COLONS)",
  "content": "Full markdown article following structure above",
  "category": "Your chosen category",
  "categoryReasoning": "Brief explanation of why this category fits best",
  "tags": ["Specific", "Searchable", "Tags", "Like iPhone17", "Not Generic"],
  "featured": true or false,
  "featuredReasoning": "Why this deserves featured status or not based on trend score, reach, breaking news value, significance",
  "metaTitle": "SEO title with primary keyword (50-60 chars, NO COLONS)",
  "metaDescription": "Benefit/hook with primary keyword (150-160 chars, NO COLONS)",
  "keywords": ["primary-keyword-phrase", "secondary-keyword", "long-tail-search-phrase"],
  "image": "/images/blog/descriptive-file-name.jpg",
  "author": "LimitBreakIT Security Insights Team" OR "LimitBreakIT Innovation Team" OR "LimitBreakIT Tech Insights Team" (choose based on topic),
  "trendScore": 75,
  "sources": "Mention 1-2 credible sources you referenced (e.g., 'The Verge, Bloomberg')"
}

🚨 FINAL REMINDERS:
- Return ONLY the JSON object - no commentary before or after
- Enforce character limits strictly (truncate at word boundaries if needed)
- Primary keyword must appear in title, excerpt, metaTitle, and opening paragraph
- DO NOT invent facts - only cite real, verifiable information
- Mention at least one credible news source in your content`;

  try {
    const { data } = await axios.post(
      'https://api.perplexity.ai/chat/completions',
      {
        model: 'sonar',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        temperature: 0.7,
        max_tokens: 4500
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
    
    // Strip any markdown wrappers
    raw = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();

    const result = JSON.parse(raw);
    
    const wordCount = countWords(result.content || '');
    const subheadings = (result.content?.match(/^##\s+.+$/gm) || []).length;
    
    if (wordCount < MIN_WORD_COUNT || subheadings < MIN_SUBHEADINGS) {
      if (retryCount < 3) {
        const waitTime = 2000 * Math.pow(2, retryCount); // Exponential backoff: 2s, 4s, 8s
        console.warn(`⚠️  Response inadequate (${wordCount} words, ${subheadings} subheadings). Retrying in ${waitTime/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        return callPerplexity(retryCount + 1, existingTopics);
      }
    }
    
    return result;
  } catch (error) {
    console.error(`❌ API Error (attempt ${retryCount + 1}/3):`, error.response?.status || error.message);
    
    if (retryCount < 3) {
      const waitTime = 2000 * Math.pow(2, retryCount);
      console.log(`⏳ Retrying in ${waitTime/1000}s...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return callPerplexity(retryCount + 1, existingTopics);
    }
    
    throw error;
  }
}

// ============================================================================
// MAIN GENERATION LOGIC
// ============================================================================

async function generateBlog() {
  console.log('🚀  Starting blog generation...\n');

  // Fetch existing posts first
  console.log('📚  Checking existing blog posts...');
  const existing = await fetchExistingSlugs();
  console.log(`✓ Found ${EXISTING_POSTS_CACHE.length} existing posts to avoid duplicating\n`);

  const trend = await callPerplexity(0, EXISTING_POSTS_CACHE);
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

  // Use AI's featured decision
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
    // Use random string instead of timestamp for shorter, cleaner slugs
    const randomSuffix = (Math.random() + 1).toString(36).substring(2, 8);
    slug = `${slug}-${randomSuffix}`;
    console.log(`⚠️  Slug collision detected, using: ${slug}`);
  }

  let content = stripFootnotes(trend.content || '');
  
  // Don't inject mid-image if AI already added inline images
  if (!content.includes('{{image:')) {
    content = injectMidImage(content);
  }

  const frontmatter = {
    slug,
    title: trend.title,
    excerpt: trend.excerpt,
    publishedAt: new Date().toISOString().split('T')[0],
    author: trend.author || 'LimitBreakIT Team',
    category: trend.category || 'Innovation',
    tags: trend.tags || [],
    image: trend.image || `/images/blog/${slug}.jpg`,
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
  console.log(`🏷️   Category: ${frontmatter.category}`);
  console.log(`🔖  Tags: ${frontmatter.tags.join(', ')}`);
  console.log(`${featured ? '⭐  Featured post' : '📌  Standard post'}`);
}

// ============================================================================
// EXECUTION
// ============================================================================

(async () => {
  try {
    if (!PERPLEXITY_API_KEY) {
      throw new Error('PERPLEXITY_API_KEY environment variable is not set');
    }

    await generateBlog();
    console.log('\n🎉  Generation complete!\n');
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
