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

  try {
    const files = await fs.readdir(POSTS_DIR);
    for (const file of files.filter(f => f.endsWith('.md'))) {
      slugs.add(file.replace('.md', ''));
      try {
        const content = await fs.readFile(path.join(POSTS_DIR, file), 'utf8');
        const titleMatch = content.match(/^title:\s*(.+)$/m);
        if (titleMatch) posts.push(titleMatch[1].trim());
      } catch (err) {
        console.warn(`⚠️  Failed to read ${file}: ${err.message}`);
      }
    }
  } catch (_) {
    // Directory doesn't exist yet - that's fine
  }

  try {
    const { data: html } = await axios.get(BLOG_BASE_URL, { timeout: 15000 });
    const matches = html.match(/\/insights-news\/([a-z0-9-]+)/g) || [];
    matches.forEach(match => {
      const slug = match.split('/').pop();
      if (slug) slugs.add(slug);
    });
    
    // Extract titles from page
    const titleMatches = html.match(/<h[2-3][^>]*>([^<]+)<\/h[2-3]>/g) || [];
    titleMatches.forEach(match => {
      const title = match.replace(/<[^>]+>/g, '').trim();
      if (title.length > 10) posts.push(title);
    });
  } catch (err) {
    console.warn(`⚠️  Could not fetch remote slugs: ${err.message}`);
  }

  EXISTING_POSTS_CACHE.push(...posts);
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
    ? `\n\nEXISTING BLOG POSTS (DO NOT duplicate these topics):\n${existingTopics.slice(0, 30).map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\nYou MUST choose a DIFFERENT story that hasn't been covered yet.`
    : '';

  const user = `Find the HOTTEST tech story from the past 48 hours that would make people stop scrolling. This needs to be genuinely trending - something people are actively talking about RIGHT NOW.

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

**First main section** (250-300 words)
Tell the story chronologically. Use **bold** for key facts, numbers, companies, and dates.
- Start with what happened - cite your source (The Verge, Bloomberg, etc.)
- Who's affected and how many people/systems
- Include **specific numbers** (dollars, users, time)
- Mention the primary keyword naturally in this section
- Add {{image:...}} at the end of this section (ONLY 1 image total in the body)

**Second main section** (250-300 words)  
Explain why this matters. Start with a strong transition like "Here's why this matters:" or "So what's the real story here?"
- **Bold** key implications
- Use bullet points for impacts:
  - Impact on users/customers
  - Impact on industry/competitors  
  - Impact on security/trust/regulation
- Consider adding a comparison table (max 1 table per article)
- Use a ### **subsection header** ONLY if this section is very complex and needs breaking down

**Third main section** (200-250 words)
Explain the technical reality in plain English.
- Use **bold** for technical terms
- Use analogies ("Think of it like...")
- Break into short paragraphs
- NO additional images here

**Fourth main section** (150-200 words)
What happens next. Start with "So where does this go from here?"
- Open questions
- Possible scenarios
- What to watch for
- Use **bold** for predictions

**Final section** (100-150 words)
The bottom line. Start with "Bottom line:" or "Here's what matters:"
*Use italics for the entire final takeaway sentence - DO NOT use bold inside the italic sentence.*
Example: *This is the key takeaway that everyone needs to understand right now.*

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
