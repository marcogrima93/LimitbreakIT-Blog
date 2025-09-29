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
const FEATURED_THRESHOLD = 70; // Trend score threshold for featured posts
const MIN_WORD_COUNT = 900; // Reduced from 1000 to be more flexible
const MIN_SUBHEADINGS = 3;

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

  // Check word count
  const wordCount = countWords(trend.content);
  if (wordCount < MIN_WORD_COUNT) {
    errors.push(`Content too short: ${wordCount} words (minimum: ${MIN_WORD_COUNT})`);
  }

  // Check for subheadings
  const subheadings = (trend.content.match(/^##\s+.+$/gm) || []).length;
  if (subheadings < MIN_SUBHEADINGS) {
    errors.push(`Insufficient structure: ${subheadings} subheadings (minimum: ${MIN_SUBHEADINGS})`);
  }

  // Check for data points
  const hasDataPoints = /\d+%|\$[\d,]+B?M?|[\d,]+\s+(users|companies|million|billion)/i.test(
    trend.content
  );
  if (!hasDataPoints) {
    warnings.push('Content may lack specific data/statistics');
  }

  // Check for required fields
  const required = [
    'title',
    'slug',
    'excerpt',
    'content',
    'category',
    'metaTitle',
    'metaDescription'
  ];
  required.forEach(field => {
    if (!trend[field] || trend[field].trim() === '') {
      errors.push(`Missing required field: ${field}`);
    }
  });

  // Check trend score
  if (
    typeof trend.trendScore !== 'number' ||
    trend.trendScore < 0 ||
    trend.trendScore > 100
  ) {
    errors.push('Invalid trendScore (must be 0-100)');
  }

  return { errors, warnings, wordCount, subheadings };
}

async function fetchExistingSlugs() {
  const slugs = new Set();

  // Fetch local slugs from Posts directory
  try {
    const files = await fs.readdir(POSTS_DIR);
    files
      .filter(f => f.endsWith('.md'))
      .forEach(f => slugs.add(f.replace('.md', '')));
  } catch (_) {
    // Directory may not exist yet, that's fine
  }

  // Try to fetch remote slugs via simple regex (no cheerio needed)
  try {
    const { data: html } = await axios.get(BLOG_BASE_URL, { timeout: 15000 });
    const matches = html.match(/\/insights-news\/([a-z0-9-]+)/g) || [];
    matches.forEach(match => {
      const slug = match.split('/').pop();
      if (slug) slugs.add(slug);
    });
  } catch (e) {
    console.warn('⚠️  Could not fetch remote slugs – continuing with local check only.');
  }

  return slugs;
}

function injectMidImage(md) {
  const words = md.split(/\s+/);
  if (words.length < 800) return md;

  const idx = md.indexOf('##');
  if (idx === -1) return md;
  const firstH2 = md.indexOf('\n', idx);
  if (firstH2 === -1) return md;

  const imgTag =
    '\n\n{{image: /images/blog/ai-tools-comparison-chart.jpg, width: 600, height: 400, alt: "Comparison of AI creative tools"}}\n';
  return md.slice(0, firstH2 + 1) + imgTag + md.slice(firstH2 + 1);
}

// ============================================================================
// PERPLEXITY API
// ============================================================================

async function callPerplexity(retryCount = 0) {
  console.log(`🔍  Calling Perplexity for trending story… ${retryCount > 0 ? `(Retry ${retryCount}/2)` : ''}`);

  const system = `You are a sharp, engaging tech journalist writing for LimitBreakIT. Your readers are smart business people who want to understand tech trends WITHOUT wading through jargon.

BRAND VOICE:
- Conversational but credible - like explaining tech news to a smart friend over coffee
- Use simple, direct language - avoid buzzwords, corporate speak, and unnecessary complexity
- Start with "So what?" - always lead with why anyone should care
- Real examples over abstract concepts
- Short sentences. Punchy paragraphs. Easy to scan.

FORBIDDEN WORDS & PHRASES (never use these):
- "revolutionize/revolutionary" - "game-changer" - "cutting-edge" - "leverage"
- "paradigm shift" - "synergy" - "ecosystem" - "disruptive" - "innovative" (overused)
- "stakeholders" - "utilize" (just say "use") - "best-in-class"
- "robust" - "holistic" - "seamless" - "transformative"
- "in today's fast-paced world" - "at the end of the day"

WRITING STYLE:
- Write like a human, not a press release
- Use contractions (it's, don't, we're)
- Ask rhetorical questions to engage readers
- Use analogies to explain complex tech ("think of it like...")
- Include surprising facts or counterintuitive angles
- Vary sentence length - mix short punchy sentences with longer explanations
- Use active voice - "Meta released" not "was released by Meta"

ENGAGEMENT HOOKS:
- Start with a surprising statistic or provocative statement
- Use real-world implications ("This means your iPhone could...")
- Include human interest angles (who wins, who loses)
- Add tension or conflict where relevant
- End sections with forward-looking questions

OUTPUT FORMAT:
Return ONLY valid JSON (no markdown code blocks, no extra text).
All facts must be real, verifiable, and less than 48 hours old.`;

  const user = `Find a genuinely interesting tech story from the past 48 hours. Not just "Company X announced Y" - find something with real stakes, real impact, or a surprising angle.

GOOD TOPICS:
- Major product launches that actually change how people work
- Big money moves (acquisitions, funding that signals market shifts)
- Tech failures or outages that reveal something interesting
- Regulatory fights or legal battles with wider implications
- Breakthrough research that's NOT just incremental improvement
- Industry drama or unexpected pivots

BAD TOPICS:
- Minor feature updates or version releases
- Corporate earnings (unless there's drama)
- Generic "AI is growing" stories without a specific hook
- Vague "trends" without concrete news

WRITING INSTRUCTIONS:

Write 1200-1500 words in a conversational, engaging style. Imagine explaining this to a smart friend who doesn't work in tech.

**Opening paragraph** (NO heading - 2-4 sentences)
Start with the most interesting angle. Make people want to keep reading. What's surprising, counterintuitive, or high-stakes about this?

Example good openings:
- "OpenAI just burned through $5 billion in 12 months. Here's why that's actually terrifying for the entire AI industry."
- "Google's new AI can't count. Sounds stupid, right? But this failure reveals something important about how these systems actually work."

DON'T start with:
- "In a significant development..." ❌
- "Company X announced..." ❌  
- "The tech industry..." ❌

## What Actually Happened
Tell the story chronologically. What went down? When? Use specific numbers, quotes, and details. Include the human drama if there is any. (200-300 words)

Write this section like you're explaining it to someone at a bar. Keep it punchy and clear.

## Why This Matters
So what? Who cares? Connect this to real-world impact. Will this affect jobs? Prices? Competition? Security? 

Use concrete examples:
- "This means small marketing agencies can now..." ✓
- "Tech leaders will need to..." ✓
NOT:
- "This enables organizations to leverage..." ❌
- "Stakeholders across the ecosystem..." ❌

(200-300 words)

## The Technical Reality
Explain HOW this actually works without getting too nerdy. Use analogies. Break down the tech in plain English.

Example: "Think of it like autocomplete on steroids" is better than "utilizing advanced neural architecture patterns."

What's genuinely new here vs. marketing hype? Be honest if something is incremental vs. breakthrough. (200-300 words)

## What Happens Next
Where does this lead? What are the unanswered questions? What should people watch for?

Include multiple scenarios if there's genuine uncertainty. Avoid fortune-telling. (150-200 words)

## The Bottom Line
One paragraph summary: What should business leaders/decision-makers take away from this? Keep it practical and actionable. No fluff. (100-150 words)

QUALITY CHECKLIST:
✓ Uses simple, direct language (8th grade reading level)
✓ No buzzwords or corporate jargon
✓ Includes at least 3 specific numbers/data points
✓ Has at least one concrete example or real-world scenario
✓ Active voice throughout
✓ Short paragraphs (3-4 sentences max)
✓ Conversational tone (uses contractions, rhetorical questions)
✓ Surprising or counterintuitive angle in opening

Return JSON:
{
  "title": "Engaging title that hints at stakes or surprise (50-65 chars)",
  "slug": "url-friendly-slug",
  "excerpt": "Hook that creates curiosity without clickbait (140-160 chars)",
  "content": "Full article following structure above (1200-1500 words)",
  "category": "AI|Cloud|Cybersecurity|DevOps|Innovation|Digital Transformation",
  "tags": ["3-5 specific tags"],
  "metaTitle": "SEO title (50-60 chars)",
  "metaDescription": "Clear benefit or hook (150-160 chars)",
  "keywords": ["primary-keyword", "secondary-keyword", "long-tail-keyword"],
  "image": "/images/blog/descriptive-name.jpg",
  "trendScore": 75
}

REMEMBER: Write like a human. Be conversational. Cut the jargon. Make it interesting.`;

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
        max_tokens: 4500 // Increased from 4000
      },
      {
        headers: {
          Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 90000 // Increased from 60000
      }
    );

    let raw = data?.choices?.[0]?.message?.content || '{}';

    // Clean up any markdown wrappers
    raw = raw
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    const result = JSON.parse(raw);
    
    // Quick validation before returning
    const wordCount = countWords(result.content || '');
    const subheadings = (result.content?.match(/^##\s+.+$/gm) || []).length;
    
    if (wordCount < MIN_WORD_COUNT || subheadings < MIN_SUBHEADINGS) {
      if (retryCount < 2) {
        console.warn(`⚠️  Response inadequate (${wordCount} words, ${subheadings} subheadings). Retrying...`);
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s before retry
        return callPerplexity(retryCount + 1);
      }
    }
    
    return result;
  } catch (error) {
    if (error.response) {
      console.error('API Error:', error.response.status, error.response.data);
    }
    throw error;
  }
}

// ============================================================================
// MAIN GENERATION LOGIC
// ============================================================================

async function generateBlog() {
  console.log('🚀  Starting blog generation...\n');

  // Step 1: Get trending story from Perplexity
  const trend = await callPerplexity();
  console.log(`📰  Received: "${trend.title}"`);

  // Step 2: Validate content quality
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

  console.log(
    `\n✓ Content validated: ${validation.wordCount} words, ${validation.subheadings} sections`
  );

  // Step 3: Determine featured status
  const featured = Number(trend.trendScore || 0) >= FEATURED_THRESHOLD;
  console.log(
    `✓ Trend score: ${trend.trendScore}/100 ${featured ? '(FEATURED)' : ''}`
  );

  // Step 4: Sanitize YAML values (remove colons that break YAML)
  ['title', 'excerpt', 'metaTitle', 'metaDescription'].forEach(k => {
    if (trend[k]) {
      trend[k] = stripColons(trend[k]);
    }
  });

  // Step 5: Ensure slug uniqueness
  const existing = await fetchExistingSlugs();
  let slug = trend.slug || slugify(trend.title);
  if (existing.has(slug)) {
    const timestamp = Date.now().toString().slice(-5);
    slug = `${slug}-${timestamp}`;
    console.log(`⚠️  Slug collision detected, using: ${slug}`);
  }

  // Step 6: Clean and enhance markdown content
  let content = stripFootnotes(trend.content || '');
  content = injectMidImage(content);

  // Step 7: Build frontmatter
  const frontmatter = {
    slug,
    title: trend.title,
    excerpt: trend.excerpt,
    publishedAt: new Date().toISOString().split('T')[0],
    author: 'LimitBreakIT Team',
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

  // Step 8: Write to file
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
