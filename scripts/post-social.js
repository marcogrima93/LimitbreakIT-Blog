/* eslint-disable no-console */
const fs = require('fs').promises;
const axios = require('axios');

const ZAPIER_WEBHOOK_URL = process.env.ZAPIER_WEBHOOK_URL;
const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;

async function generateSocialContent(blogPost) {
  console.log('\n📱  Generating social media content...');

  const prompt = `Create 3 social media posts for this blog article. Return ONLY valid JSON.

BLOG:
- Title: ${blogPost.title}
- Excerpt: ${blogPost.excerpt}
- Category: ${blogPost.category}
- URL: ${blogPost.url}

REQUIREMENTS:
- LinkedIn: Professional, 700-1000 chars, 3-5 hashtags, include URL
- Facebook: Conversational, 400-600 chars, 2-3 hashtags, include URL
- Instagram: Visual/casual, 150-300 chars, 5-10 hashtags, say "Link in bio" (NO URL)

Return this exact JSON structure:
{
  "linkedin": "Professional LinkedIn post with hashtags and ${blogPost.url}",
  "facebook": "Conversational Facebook post with hashtags and ${blogPost.url}",
  "instagram": "Visual Instagram post with emojis and 'Link in bio' (no URL)"
}`;

  try {
    const { data } = await axios.post(
      'https://api.perplexity.ai/chat/completions',
      {
        model: 'sonar-pro',
        messages: [
          { role: 'system', content: 'Return ONLY valid JSON, no markdown.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.8,
        max_tokens: 2000
      },
      {
        headers: {
          'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    let raw = data?.choices?.[0]?.message?.content?.trim() || '{}';
    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1) {
      raw = raw.substring(jsonStart, jsonEnd + 1);
    }

    return JSON.parse(raw);
  } catch (error) {
    console.error('❌ Failed to generate social content:', error.message);
    throw error;
  }
}

async function sendToZapier(blogPost, socialContent) {
  if (!ZAPIER_WEBHOOK_URL) {
    console.warn('⚠️  ZAPIER_WEBHOOK_URL not set - skipping social posting');
    return { success: false, reason: 'No webhook configured' };
  }

  try {
    console.log('\n📤 Sending to Zapier webhook...');

    const payload = {
      // Blog metadata
      blog_title: blogPost.title,
      blog_url: blogPost.url,
      blog_excerpt: blogPost.excerpt,
      blog_category: blogPost.category,
      
      // Social content
      linkedin_post: socialContent.linkedin,
      facebook_post: socialContent.facebook,
      instagram_caption: socialContent.instagram,
      
      // Timestamp
      posted_at: new Date().toISOString()
    };

    const { data } = await axios.post(ZAPIER_WEBHOOK_URL, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    });

    console.log('✅ Successfully sent to Zapier');
    console.log('   → LinkedIn, Facebook, Instagram posts queued');
    
    return { success: true, data };
  } catch (error) {
    console.error('❌ Zapier webhook failed:', error.message);
    return { success: false, error: error.message };
  }
}

async function saveInstagramCaption(socialContent) {
  try {
    const captionFile = `instagram-captions/caption-${Date.now()}.txt`;
    await fs.mkdir('instagram-captions', { recursive: true });
    await fs.writeFile(captionFile, socialContent.instagram, 'utf8');
    console.log(`✓ Instagram caption saved: ${captionFile}`);
    return captionFile;
  } catch (error) {
    console.warn('⚠️  Failed to save Instagram caption:', error.message);
    return null;
  }
}

async function main() {
  try {
    const blogFile = process.argv[2];
    
    if (!blogFile) {
      throw new Error('Blog post file path required as argument');
    }

    console.log(`\n📖 Reading blog post: ${blogFile}`);
    const content = await fs.readFile(blogFile, 'utf8');

    // Extract frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]+?)\n---/);
    if (!frontmatterMatch) {
      throw new Error('No frontmatter found in blog post');
    }

    const yaml = require('js-yaml');
    const metadata = yaml.load(frontmatterMatch[1]);

    const blogPost = {
      title: metadata.title,
      excerpt: metadata.excerpt,
      category: metadata.category,
      url: `https://www.limitbreakit.com/insights-news/${metadata.slug}`,
      slug: metadata.slug
    };

    console.log('✓ Blog metadata extracted');
    console.log(`  Title: ${blogPost.title}`);
    console.log(`  URL: ${blogPost.url}`);

    // Generate social content
    const socialContent = await generateSocialContent(blogPost);
    
    console.log('\n📝 Generated Content Preview:');
    console.log('\n💼 LinkedIn:');
    console.log(socialContent.linkedin.substring(0, 150) + '...');
    console.log('\n📘 Facebook:');
    console.log(socialContent.facebook.substring(0, 150) + '...');
    console.log('\n📸 Instagram:');
    console.log(socialContent.instagram.substring(0, 150) + '...');

    // Send to Zapier (posts to all platforms)
    const result = await sendToZapier(blogPost, socialContent);

    // Also save Instagram caption locally as backup
    await saveInstagramCaption(socialContent);

    if (!result.success) {
      console.error('\n❌ Social posting failed');
      process.exit(1);
    }

    console.log('\n✅ Social media posting complete!');

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  }
}

main();
