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
const FEATURED_THRESHOLD = 70;
const MIN_WORD_COUNT = 500;

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

  return { errors, warnings, wordCount };
}

async function fetchExistingSlugs() {
  const slugs = new Set();

  try {
    const files = await fs.readdir(POSTS_DIR);
    files.filter(f => f.endsWith('.md')).forEach(f => slugs.add(f.replace('.md', '')));
  } catch (_) {
    // Directory may not exist yet
  }

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

  const imgTag = '\n\n{{image: /images/blog/ai-tools-comparison-chart.jpg, width: 600, height: 400, alt: "Comparison of AI creative tools"}}\n';
  return md.slice(0, firstH2 + 1) + imgTag + md.slice(firstH2 + 1);
}

// ============================================================================
// PERPLEXITY API
// ============================================================================

async function callPerplexity(retryCount = 0) {
  console.log(`🔍  Calling Perplexity… ${retryCount > 0 ? `(Retry ${retryCount}/2)` : ''}`);

  const system = `You are a sharp tech journalist for LimitBreakIT. Write conversational content that's easy to read.

VOICE: Conversational, no jargon, short sentences, active voice.

NEVER USE: "revolutionize", "game-changer", "cutting-edge", "leverage", "paradigm shift", "synergy", "disruptive", "stakeholders", "utilize", "robust", "holistic", "seamless"

Return ONLY valid JSON (no markdown wrappers).`;

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

Write a minimum of 1000 words in conversational style.

**Opening** (2-4 sentences, no heading)
Start with the most interesting angle. Make people want to keep reading. What's surprising, counterintuitive, or high-stakes about this?

Example good openings:
- "OpenAI just burned through $5 billion in 12 months. Here's why that's actually terrifying for the entire AI industry."
- "Google's new AI can't count. Sounds stupid, right? But this failure reveals something important about how these systems actually work."

DON'T start with:
- "In a significant development..." ❌
- "Company X announced..." ❌  
- "The tech industry..." ❌

## What Actually Happened
Tell the story. What went down? When? Specific numbers and details. (250+ words)

## Why This Matters
So what? Real-world impact. Concrete examples. (250+ words)

## The Technical Reality
Explain HOW it works in plain English. Use analogies. (200+ words)

## What Happens Next
Where does this lead? Unanswered questions. (150+ words)

## The Bottom Line
Summary for decision-makers. Practical and actionable. (100+ words)

QUALITY CHECKLIST:
✓ Minimum 1000 words
✓ Simple language, no jargon
✓ 3+ specific data points
✓ Active voice
✓ Short paragraphs
✓ Conversational tone

Return JSON:
{
  "title": "Engaging title (50-65 chars)",
  "slug": "url-friendly-slug",
  "excerpt": "Hook (140-160 chars)",
  "content": "Full article, 1000+ words minimum",
  "category": "AI|Cloud|Cybersecurity|DevOps|Innovation|Digital Transformation",
  "tags": ["3-5 tags"],
  "metaTitle": "SEO title (50-60 chars)",
  "metaDescription": "Clear benefit (150-160 chars)",
  "keywords": ["primary", "secondary", "long-tail"],
  "image": "/images/blog/name.jpg",
  "trendScore": 75
}`;

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

    let raw = data?.choices?.[0]?.message?.content || '{}';

    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    const result = JSON.parse(raw);
    
    const wordCount = countWords(result.content || '');
    
    if (wordCount < MIN_WORD_COUNT) {
      if (retryCount < 2) {
        console.warn(`⚠️  Response too short (${wordCount} words). Retrying...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
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

  const trend = await callPerplexity();
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

  console.log(`\n✓ Content validated: ${validation.wordCount} words`);

  const featured = Number(trend.trendScore || 0) >= FEATURED_THRESHOLD;
  console.log(`✓ Trend score: ${trend.trendScore}/100 ${featured ? '(FEATURED)' : ''}`);

  ['title', 'excerpt', 'metaTitle', 'metaDescription'].forEach(k => {
    if (trend[k]) {
      trend[k] = stripColons(trend[k]);
    }
  });

  const existing = await fetchExistingSlugs();
  let slug = trend.slug || slugify(trend.title);
  if (existing.has(slug)) {
    const timestamp = Date.now().toString().slice(-5);
    slug = `${slug}-${timestamp}`;
    console.log(`⚠️  Slug collision detected, using: ${slug}`);
  }

  let content = stripFootnotes(trend.content || '');
  content = injectMidImage(content);

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