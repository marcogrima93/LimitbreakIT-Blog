/* eslint-disable no-console */
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const yaml = require('js-yaml');

// ============================================================================
// CONFIGURATION
// ============================================================================

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;
const POSTS_DIR = 'Posts';
const BLOG_BASE_URL = 'https://www.limitbreakit.com/insights-news';
const FEATURED_THRESHOLD = 70;
const MIN_WORD_COUNT = 500;
const MIN_SUBHEADINGS = 3;
const EXISTING_POSTS_CACHE = [];

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
      const slug = file.replace('.md', '');
      slugs.add(slug);

      try {
        const content = await fs.readFile(path.join(POSTS_DIR, file), 'utf8');
        const titleMatch = content.match(/^title:\s*(.+)$/m);
        if (titleMatch) {
          posts.push(titleMatch[1].trim());
        }
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

  try {
    const { data: html } = await axios.get(BLOG_BASE_URL, { timeout: 15000 });

    const slugMatches = html.match(/\/insights-news\/([a-z0-9-]+)/g) || [];
    slugMatches.forEach(match => {
      const slug = match.split('/').pop();
      if (slug && slug.length > 5) slugs.add(slug);
    });

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

  const uniquePosts = [...new Set(posts)]
    .filter(p => p.length > 15 && p.length < 150)
    .map(p => p.replace(/\s+/g, ' ').trim());

  EXISTING_POSTS_CACHE.push(...uniquePosts);

  console.log(`✓ Extracted ${uniquePosts.length} unique post topics for duplicate detection`);

  return slugs;
}

// ============================================================================
// IMAGE FETCHING
// ============================================================================

async function fetchUnsplashImage(keywords, category, title, size = 'header', customQuery = null) {
  if (!UNSPLASH_ACCESS_KEY) {
    console.warn('⚠️  UNSPLASH_ACCESS_KEY not set - cannot fetch images');
    return null;
  }

  try {
    let searchTerms;
    let resultIndex = 0;
    
    if (customQuery) {
      searchTerms = customQuery;
      console.log(`🖼️  Using AI search query: "${searchTerms}" (${size})`);
    } else if (size === 'inline') {
      searchTerms = keywords.slice(1, 4).join(' ') || `${category} technology`;
      resultIndex = 1;
      console.log(`🖼️  Searching Unsplash (fallback): "${searchTerms}" (${size})`);
    } else {
      searchTerms = [category.toLowerCase(), ...keywords.slice(0, 2)].join(' ');
      console.log(`🖼️  Searching Unsplash: "${searchTerms}" (${size})`);
    }

    const { data } = await axios.get('https://api.unsplash.com/search/photos', {
      params: {
        query: searchTerms,
        per_page: 5,
        orientation: 'landscape',
        content_filter: 'high'
      },
      headers: {
        'Authorization': `Client-ID ${UNSPLASH_ACCESS_KEY}`
      },
      timeout: 10000
    });

    if (data.results && data.results.length > 0) {
      const photoIndex = Math.min(resultIndex, data.results.length - 1);
      const photo = data.results[photoIndex];

      let width, height;
      if (size === 'header') {
        width = 1200;
        height = 600;
      } else {
        width = 800;
        height = 450;
      }

      const optimizedUrl = `${photo.urls.raw}&w=${width}&h=${height}&fit=crop&q=80`;

      console.log(`✓ Found ${size} image by ${photo.user.name} (${width}x${height}) [result #${photoIndex + 1}]`);

      return {
        url: optimizedUrl,
        alt: photo.alt_description || `${title} - ${category} technology`,
        credit: `Photo by ${photo.user.name} on Unsplash`,
        downloadLocation: photo.links.download_location,
        width,
        height
      };
    }

    console.warn('⚠️  No Unsplash images found for query');
    return null;
  } catch (error) {
    console.warn(`⚠️  Unsplash API error: ${error.message}`);
    return null;
  }
}

async function triggerUnsplashDownload(downloadLocation) {
  if (!downloadLocation || !UNSPLASH_ACCESS_KEY) return;

  try {
    await axios.get(downloadLocation, {
      headers: { 'Authorization': `Client-ID ${UNSPLASH_ACCESS_KEY}` }
    });
  } catch (_) {}
}

async function processInlineImages(content, keywords, category, title, creditsArray = []) {
  const imageTagRegex = /\{\{image:\s*([^,]+),\s*width:\s*(\d+),\s*height:\s*(\d+),\s*alt:\s*"([^"]+)"\}\}/g;
  const matches = [...content.matchAll(imageTagRegex)];

  if (matches.length === 0) {
    console.log('ℹ️  No inline image tags found in AI content');
    return content;
  }

  console.log(`🖼️  Found ${matches.length} inline image tag(s) to process`);

  let updatedContent = content;

  for (const match of matches) {
    const [fullMatch, aiSearchQuery, width, height, alt] = match;
    
    console.log(`🖼️  AI requested image for: "${aiSearchQuery.trim()}"`);

    const imageData = await fetchUnsplashImage(
      keywords,
      category,
      title,
      'inline',
      aiSearchQuery.trim()
    );

    if (imageData) {
      await triggerUnsplashDownload(imageData.downloadLocation);
      
      if (imageData.credit) {
        creditsArray.push(imageData.credit);
      }
      
      const replacement = `{{image: ${imageData.url}, width: ${width}, height: ${height}, alt: "${alt}"}}`;
      updatedContent = updatedContent.replace(fullMatch, replacement);
      
      console.log(`✓ Replaced with: ${imageData.url.substring(0, 70)}...`);
    } else {
      console.warn(`⚠️  Could not fetch inline image for "${aiSearchQuery.trim()}", removing tag`);
      updatedContent = updatedContent.replace(fullMatch, '');
    }
  }

  return updatedContent;
}

// ============================================================================
// PERPLEXITY API WITH PROPER JSON SANITIZATION
// ============================================================================

async function callPerplexity(retryCount = 0, existingTopics = []) {
  console.log(`🔍  Calling Perplexity… ${retryCount > 0 ? `(Retry ${retryCount}/2)` : ''}`);

  const system = `You are the world's best trending tech blogger. You cover EVERYTHING hot in tech - from devastating cyberattacks to game-changing product launches, from billion-dollar acquisitions to industry-shaking scandals.

Your readers trust you to break down complex tech news into stories they can't stop reading. You write like a journalist at The Verge meets a cybersecurity expert - informed, punchy, and always on top of what's trending RIGHT NOW.

CRITICAL JSON FORMATTING RULES:
- Return ONLY valid JSON with properly escaped special characters
- ALL newlines in content MUST be literal \\n characters (not actual line breaks)
- Use standard markdown: *italic*, **bold**, ## Headers, [links](url)
- NO literal line breaks inside JSON string values
- Escape quotes as \\" inside string values

CRITICAL FORMATTING RULES:
- *text* = italic text for subtle emphasis or quotes
- **text** = bold for KEY TERMS, numbers, and important points
- [text](url) = links (when you mention specific products/companies/sources)
- ## Big Header = main section headers
- ### **Subheader** = subsections within main sections
- Tables for comparisons using | markdown syntax
- Bullet points with - for lists

LINKS AND REFERENCES (CRITICAL):
- You MUST include 3-5 inline links throughout the article using [text](url) format
- Link to your actual sources when you mention them
- Link to official product pages when mentioning products
- Link to company websites when first mentioning companies
- Link to security advisories when mentioning CVEs or vulnerabilities
- NEVER use placeholder URLs like "example.com" - use real, relevant URLs from your research

INLINE IMAGE TAGS:
- You CAN and SHOULD add ONE inline image using {{image: search-query, width: 800, height: 450, alt: "description"}} tags
- Place it after the first ## section if the article is 800+ words
- The search-query should be 3-6 DESCRIPTIVE keywords that accurately describe what the image should show
- Be SPECIFIC with your search query

FORMATTING REQUIREMENTS:
✓ SHORT paragraphs (2-4 sentences max)
✓ Blank lines between paragraphs (use \\n\\n)
✓ Use **bold** liberally (8-12 times per article)
✓ Use *italics* for quotes or subtle emphasis (3-5 times)
✓ Include 3-5 inline hyperlinks to sources [text](url)
✓ Include 1-2 tables if comparing data
✓ Use bullet points for lists
✓ Include specific numbers with **bold** emphasis

VOICE: 
- Punchy and conversational
- No corporate BS or jargon
- Short, varied sentences
- Write like breaking news to a friend
- Break long sentences into shorter ones - NEVER use em dashes (—)

BANNED WORDS: "revolutionize", "game-changer", "cutting-edge", "leverage", "paradigm shift", "synergy", "disruptive", "stakeholders", "utilize", "robust", "seamless", "transformative"

YAML HEADER RULES:
- NEVER use colons (:) in any YAML values
- Replace colons with dashes (-)
- Keep titles under 65 characters
- Excerpts must be 140-160 characters

🚨 CRITICAL: Return ONLY valid JSON. NO markdown code blocks. NO backticks. Just pure JSON starting with { and ending with }.`;

  const existingTopicsList = existingTopics.length > 0 
    ? `\n\nEXISTING BLOG POSTS (DO NOT duplicate these topics or angles):\n${existingTopics.slice(0, 50).map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\nCRITICAL DUPLICATE DETECTION:\n- Use fuzzy matching to detect duplicates even if titles differ slightly\n- If your chosen topic is even remotely similar to anything above, PICK SOMETHING ELSE`
    : '';

  const user = `Find the HOTTEST tech story from the past 48 hours that would make people stop scrolling. This needs to be genuinely trending - something people are actively talking about RIGHT NOW.${existingTopicsList}

Write 1000+ words. SHORT paragraphs (2-4 sentences). Use \\n\\n between ALL paragraphs.

Return this EXACT JSON structure with properly escaped content:

{
  "title": "Keyword-rich title (50-65 chars, NO COLONS)",
  "slug": "url-friendly-slug",
  "excerpt": "Compelling hook (140-160 chars, NO COLONS)",
  "content": "Full markdown article with \\n\\n between paragraphs",
  "category": "Best fitting category",
  "categoryReasoning": "Why this category fits",
  "tags": ["Specific", "Searchable", "Tags"],
  "featured": true,
  "featuredReasoning": "Why this is featured",
  "metaTitle": "SEO title (50-60 chars, NO COLONS)",
  "metaDescription": "SEO description (150-160 chars, NO COLONS)",
  "keywords": ["primary-keyword", "secondary-keyword"],
  "image": "/images/blog/descriptive-file-name.jpg",
  "author": "LimitBreakIT Security Insights Team",
  "trendScore": 85,
  "sources": "Mention 1-2 credible sources"
}

🚨 CRITICAL: Return ONLY the JSON object. No markdown wrappers. No backticks. Just pure JSON.`;

  try {
    console.log('\n' + '='.repeat(80));
    console.log('📤  Calling Perplexity API...');
    console.log('='.repeat(80) + '\n');

    const { data } = await axios.post(
      'https://api.perplexity.ai/chat/completions',
      {
        model: 'sonar-pro',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
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

    console.log('📥 Received response from Perplexity');
    console.log('🔍 Raw response length:', raw.length, 'characters');

    // Strip <think> tags from sonar-reasoning-pro
    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    
    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
      raw = raw.substring(jsonStart, jsonEnd + 1);
    }

    // Remove markdown wrappers
    raw = raw.replace(/^```json\s*/i, '').replace(/^``````$/g, '').trim();

    console.log('✂️  Cleaned response, attempting to parse JSON...');

    let result;
    try {
      result = JSON.parse(raw);
      console.log('✅ Successfully parsed JSON on first attempt');
    } catch (parseError) {
      console.warn('⚠️  First parse failed, applying control character sanitization...');
      console.error('Parse error:', parseError.message);
      
      // Show problematic area
      const errorMatch = parseError.message.match(/position (\d+)/);
      if (errorMatch) {
        const pos = parseInt(errorMatch);
        console.log('❌ Error near:', raw.substring(Math.max(0, pos - 50), pos + 50));
      }

      // Aggressive sanitization - remove ALL control characters except intentional escapes
      raw = raw
        .replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F]/g, '') // Remove control chars
        .replace(/\\n/g, '__NEWLINE__')  // Protect escaped newlines
        .replace(/\\t/g, '__TAB__')       // Protect escaped tabs
        .replace(/\\"/g, '__QUOTE__')     // Protect escaped quotes
        .replace(/\r\n/g, ' ')            // Replace actual line breaks with spaces
        .replace(/\n/g, ' ')
        .replace(/\r/g, ' ')
        .replace(/\t/g, ' ')
        .replace(/__NEWLINE__/g, '\\n')   // Restore escaped newlines
        .replace(/__TAB__/g, '\\t')       // Restore escaped tabs
        .replace(/__QUOTE__/g, '\\"');    // Restore escaped quotes

      console.log('🧹 Sanitized JSON (first 500 chars):', raw.substring(0, 500));
      
      result = JSON.parse(raw);
      console.log('✅ Successfully parsed JSON after sanitization');
    }

    const wordCount = countWords(result.content || '');
    const subheadings = (result.content?.match(/^##\s+.+$/gm) || []).length;

    console.log(`📊 Content stats: ${wordCount} words, ${subheadings} subheadings`);

    if (wordCount < MIN_WORD_COUNT || subheadings < MIN_SUBHEADINGS) {
      if (retryCount < 3) {
        const waitTime = 2000 * Math.pow(2, retryCount);
        console.warn(`⚠️  Response inadequate. Retrying in ${waitTime/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        return callPerplexity(retryCount + 1, existingTopics);
      }
    }

    return result;
  } catch (error) {
    console.error(`❌ API Error (attempt ${retryCount + 1}/4):`, error.message);
    
    if (error instanceof SyntaxError && raw) {
      console.error('📋 Problematic JSON (first 1000 chars):', raw.substring(0, 1000));
    }

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
  let imageCredit = null;

  console.log('\n🖼️  Fetching blog header image (1200x600)...');
  const imageData = await fetchUnsplashImage(
    trend.keywords || [],
    trend.category,
    trend.title,
    'header'
  );

  if (imageData) {
    imageUrl = imageData.url;
    imageCredit = imageData.credit;
    await triggerUnsplashDownload(imageData.downloadLocation);
    console.log(`✓ Header image: ${imageUrl.substring(0, 80)}...`);
  } else {
    console.warn('⚠️  Could not fetch header image from Unsplash');
    imageUrl = `/images/blog/${slug}.jpg`;
  }

  let content = stripFootnotes(trend.content || '');

  console.log('\n🖼️  Processing inline images...');
  const inlineImageCredits = [];
  content = await processInlineImages(content, trend.keywords || [], trend.category, trend.title, inlineImageCredits);

  const allCredits = [];
  if (imageCredit) allCredits.push(imageCredit);
  if (inlineImageCredits.length > 0) allCredits.push(...inlineImageCredits);
  
  if (allCredits.length > 0) {
    content += `\n\n---\n\n*${allCredits.join(' | ')}*`;
  }

  const frontmatter = {
    slug,
    title: trend.title,
    excerpt: trend.excerpt,
    publishedAt: new Date().toISOString().split('T'),
    author: trend.author || 'LimitBreakIT Team',
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
  console.log(`🏷️   Category: ${frontmatter.category}`);
  console.log(`🔖  Tags: ${frontmatter.tags.join(', ')}`);
  console.log(`🖼️  Header image: ${imageUrl.substring(0, 80)}...`);
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

    if (!UNSPLASH_ACCESS_KEY) {
      console.warn('⚠️  UNSPLASH_ACCESS_KEY not set - will use placeholder images');
      console.warn('   Get free key at: https://unsplash.com/developers\n');
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
