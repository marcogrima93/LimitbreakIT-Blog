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

  const system = `You are an expert tech journalist writing for LimitBreakIT, a Malta-based technology consultancy specializing in AI, cloud infrastructure, and digital transformation.

BRAND VOICE & STYLE:
- Professional yet accessible and engaging
- Data-driven with concrete examples and statistics
- Forward-thinking and analytical
- Authoritative but not condescending
- Targeted at CTOs, tech leaders, and innovators

WRITING PRINCIPLES:
- Lead with impact: Start strong with why this matters NOW
- Show, don't tell: Use specific data, quotes, and examples
- Structure for scanning: Clear subheadings, short paragraphs
- Provide value: Go beyond news recap to offer insights and implications
- End with perspective: What should readers watch for or consider?

CRITICAL: The content field MUST contain markdown with ## subheadings. Example format:
## First Major Heading
Content here...

## Second Major Heading
More content...

## Third Major Heading
Even more content...

OUTPUT FORMAT:
Return ONLY valid JSON (no markdown code blocks, no extra text).
All facts must be real, verifiable, and less than 48 hours old.`;

  const user = `Find the single most trending and impactful tech story from the past 48 hours that would interest CTOs, tech leaders, and innovators.

TOPIC SELECTION CRITERIA:
✅ PREFER: Major product launches, significant funding rounds, breakthrough research, regulatory changes, major outages/incidents, transformative AI developments
❌ AVOID: Minor feature updates, routine earnings reports, opinion pieces without news hooks

MANDATORY CONTENT STRUCTURE (1200-1500 words):

**Opening paragraph** (2-3 sentences - NO heading)
Make it clear why this matters RIGHT NOW.

## Background and Context
Brief context for readers unfamiliar with the topic. Key players and their significance. Why this development is noteworthy. (150-200 words)

## What Happened
Concrete facts and timeline. What's actually new or different. Include specific data points. (200-250 words)

## Technical Analysis
Deep-dive into the technology. How it works. What makes it different from existing solutions. (200-250 words)

## Industry Impact
How this affects businesses and markets. Expert perspectives and analyst quotes. Market reactions. (200-250 words)

## Strategic Implications
What this means for tech leaders and decision-makers. Practical considerations for CTOs. How this relates to challenges businesses face today. (150-200 words)

## Looking Ahead
What to watch for next. Unanswered questions. Potential future developments. (150-200 words)

QUALITY REQUIREMENTS:
- MINIMUM 1200 words total
- EXACTLY 5 sections with ## headings (shown above)
- Include at least 3 specific data points (percentages, dollar amounts, user numbers)
- At least one concrete example or case study
- Write in active voice
- No generic statements like "in today's fast-paced world"

Return JSON with EXACTLY these fields:
{
  "title": "Compelling title (55-65 characters)",
  "slug": "url-friendly-slug",
  "excerpt": "Engaging 150-160 character summary",
  "content": "FULL MARKDOWN with ## subheadings as shown above (1200-1500 words)",
  "category": "One of: AI|Cloud|Cybersecurity|DevOps|Innovation|Digital Transformation",
  "tags": ["3-5 specific tags"],
  "metaTitle": "SEO title (50-60 chars)",
  "metaDescription": "SEO description with CTA (150-160 chars)",
  "keywords": ["primary-keyword", "secondary-keyword", "long-tail-keyword"],
  "image": "/images/blog/descriptive-name.jpg",
  "trendScore": 75
}

CRITICAL: The "content" field MUST include the 5 ## section headings shown above. Without them, the output will be rejected.`;

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
