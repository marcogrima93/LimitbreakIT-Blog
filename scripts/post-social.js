/* eslint-disable no-console */
const axios = require('axios');
const fs = require('fs').promises;

// ============================================================================
// CONFIGURATION
// ============================================================================

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;

// Social Media API Keys
const LINKEDIN_ACCESS_TOKEN = process.env.LINKEDIN_ACCESS_TOKEN;
const LINKEDIN_ORG_ID = process.env.LINKEDIN_ORG_ID; // Your company page ID

const FACEBOOK_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN;
const FACEBOOK_PAGE_ID = process.env.FACEBOOK_PAGE_ID;

const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const INSTAGRAM_BUSINESS_ACCOUNT_ID = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;

// ============================================================================
// SOCIAL CONTENT GENERATION
// ============================================================================

async function generateSocialContent(blogPost) {
  console.log('\n📱  Generating social media content...');

  const prompt = `You are a social media expert for a tech company. Create engaging social media posts for the following blog article.

BLOG DETAILS:
Title: ${blogPost.title}
Excerpt: ${blogPost.excerpt}
Category: ${blogPost.category}
URL: ${blogPost.url}

CRITICAL RULES:
1. Each platform needs a DIFFERENT post - don't just repeat the same text
2. Match the platform's style and culture
3. Include the blog URL at the end of each post (except Instagram - use "Link in bio")
4. Use platform-appropriate formatting (hashtags, emojis, line breaks)
5. Create urgency and curiosity - make people WANT to click

PLATFORM REQUIREMENTS:

**LinkedIn** (700-1300 chars recommended):
- Professional tone but still engaging
- Lead with the business impact or insight
- 2-3 short paragraphs with line breaks
- 3-5 relevant hashtags at the end
- Ask a thought-provoking question or call-to-action
- Example format:
  "The latest [Company] breach affects 2M+ users. But here's what most coverage is missing...
  
  [Key insight or business angle - 2-3 sentences]
  
  For IT leaders, this means [practical implication].
  
  Full technical breakdown + what to do next: [URL]
  
  #Cybersecurity #DataBreach #ITLeadership"

**Facebook** (400-600 chars recommended):
- Conversational and accessible
- Focus on "why this matters to you"
- Use line breaks for readability
- 2-3 hashtags (Facebook uses fewer)
- Can use 1-2 emojis if natural
- Example: "Your firewall might be wide open right now. 😬
  
  A critical bug in Cisco devices is being actively exploited - and 50,000+ companies are vulnerable.
  
  Here's what you need to know (and do) TODAY:
  [URL]
  
  #CyberSecurity #BusinessTech"

**Instagram** (MAX 2200 chars, aim for 150-300):
- VISUAL and casual language
- Focus on ONE key insight or shocking fact
- Use line breaks and emojis strategically
- 5-10 hashtags (Instagram rewards more hashtags)
- NO CLICKABLE LINKS - say "Link in bio" instead
- First line must HOOK (people see this in feed before "more...")
- Example: "🚨 50,000 firewalls just got exposed
  
  Not a drill. Hackers are racing to exploit this flaw right now.
  
  Are you patched? Most companies aren't. 😬
  
  Full breakdown + what to do 👉 Link in bio
  
  #Cybersecurity #InfoSec #TechNews #DataBreach #ITSecurity #CyberAttack #NetworkSecurity #InfoSecCommunity #CyberAware #TechAlert"

Return ONLY valid JSON with NO markdown wrappers:

{
  "linkedin": "Your LinkedIn post with professional tone and hashtags",
  "facebook": "Your Facebook post with conversational tone",
  "instagram": "Your Instagram post with emojis, line breaks, and 'Link in bio' (NO URL)"
}`;

  try {
    const { data } = await axios.post(
      'https://api.perplexity.ai/chat/completions',
      {
        model: 'sonar-pro',
        messages: [
          { 
            role: 'system', 
            content: 'You are a social media expert. Return ONLY valid JSON with no markdown wrappers or commentary.' 
          },
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

    // Extract JSON
    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1) {
      raw = raw.substring(jsonStart, jsonEnd + 1);
    }

    const socialContent = JSON.parse(raw);

    // Replace [URL] placeholder with actual URL (except Instagram)
    if (socialContent.linkedin) {
      socialContent.linkedin = socialContent.linkedin.replace(/\[URL\]/g, blogPost.url);
    }
    if (socialContent.facebook) {
      socialContent.facebook = socialContent.facebook.replace(/\[URL\]/g, blogPost.url);
    }

    console.log('✓ Social content generated for all platforms');
    return socialContent;

  } catch (error) {
    console.error('❌ Failed to generate social content:', error.message);
    throw error;
  }
}

// ============================================================================
// PLATFORM POSTING FUNCTIONS
// ============================================================================

async function postToLinkedIn(content) {
  if (!LINKEDIN_ACCESS_TOKEN || !LINKEDIN_ORG_ID) {
    console.warn('⚠️  LinkedIn credentials not configured - skipping');
    return { success: false, reason: 'No credentials' };
  }

  try {
    console.log('💼 Posting to LinkedIn...');

    const payload = {
      author: `urn:li:organization:${LINKEDIN_ORG_ID}`,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: {
            text: content
          },
          shareMediaCategory: 'NONE'
        }
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC'
      }
    };

    const { data } = await axios.post(
      'https://api.linkedin.com/v2/ugcPosts',
      payload,
      {
        headers: {
          'Authorization': `Bearer ${LINKEDIN_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
          'X-Restli-Protocol-Version': '2.0.0'
        }
      }
    );

    console.log(`✓ Posted to LinkedIn: ${data.id}`);
    return { success: true, id: data.id };

  } catch (error) {
    console.error('❌ LinkedIn posting failed:', error.response?.data || error.message);
    return { success: false, error: error.message };
  }
}

async function postToFacebook(content) {
  if (!FACEBOOK_ACCESS_TOKEN || !FACEBOOK_PAGE_ID) {
    console.warn('⚠️  Facebook credentials not configured - skipping');
    return { success: false, reason: 'No credentials' };
  }

  try {
    console.log('📘 Posting to Facebook...');

    const { data } = await axios.post(
      `https://graph.facebook.com/v18.0/${FACEBOOK_PAGE_ID}/feed`,
      {
        message: content,
        access_token: FACEBOOK_ACCESS_TOKEN
      }
    );

    console.log(`✓ Posted to Facebook: ${data.id}`);
    return { 
      success: true, 
      id: data.id,
      url: `https://www.facebook.com/${FACEBOOK_PAGE_ID}/posts/${data.id.split('_')[1]}`
    };

  } catch (error) {
    console.error('❌ Facebook posting failed:', error.response?.data || error.message);
    return { success: false, error: error.message };
  }
}

async function postToInstagram(content) {
  if (!INSTAGRAM_ACCESS_TOKEN || !INSTAGRAM_BUSINESS_ACCOUNT_ID) {
    console.warn('⚠️  Instagram credentials not configured - skipping');
    return { success: false, reason: 'No credentials' };
  }

  try {
    console.log('📸 Creating Instagram post...');
    console.log('⚠️  NOTE: Instagram requires an image. Saving caption to file for manual posting.');

    // Instagram Graph API requires media (image/video)
    // Since we're auto-generating text, save caption for manual posting with image
    const captionFile = `instagram-captions/caption-${Date.now()}.txt`;
    await fs.mkdir('instagram-captions', { recursive: true });
    await fs.writeFile(captionFile, content, 'utf8');

    console.log(`✓ Instagram caption saved to: ${captionFile}`);
    console.log('   → Manually post this with your blog featured image');

    return { 
      success: true, 
      manual: true,
      captionFile,
      note: 'Instagram requires manual posting with image'
    };

  } catch (error) {
    console.error('❌ Instagram caption save failed:', error.message);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// MAIN POSTING ORCHESTRATOR
// ============================================================================

async function postToSocialMedia(blogPost) {
  console.log('\n' + '='.repeat(80));
  console.log('📱  SOCIAL MEDIA POSTING');
  console.log('='.repeat(80));

  try {
    const socialContent = await generateSocialContent(blogPost);

    console.log('\n📝 Generated Content Preview:');
    console.log('\n💼 LinkedIn:');
    console.log(socialContent.linkedin);
    console.log('\n📘 Facebook:');
    console.log(socialContent.facebook);
    console.log('\n📸 Instagram:');
    console.log(socialContent.instagram);
    console.log('\n' + '-'.repeat(80));

    // Post to all platforms concurrently
    const results = await Promise.allSettled([
      postToLinkedIn(socialContent.linkedin),
      postToFacebook(socialContent.facebook),
      postToInstagram(socialContent.instagram)
    ]);

    // Summary
    console.log('\n' + '='.repeat(80));
    console.log('📊 POSTING SUMMARY');
    console.log('='.repeat(80));

    const summary = {
      linkedin: results[0].status === 'fulfilled' ? results[0].value : { success: false },
      facebook: results[1].status === 'fulfilled' ? results[1].value : { success: false },
      instagram: results[2].status === 'fulfilled' ? results[2].value : { success: false }
    };

    Object.entries(summary).forEach(([platform, result]) => {
      const icon = result.success ? '✓' : '✗';
      const status = result.success ? 'SUCCESS' : 'FAILED';
      console.log(`${icon} ${platform.toUpperCase()}: ${status}`);
      if (result.url) console.log(`   → ${result.url}`);
      if (result.captionFile) console.log(`   → Caption saved: ${result.captionFile}`);
    });

    console.log('='.repeat(80) + '\n');

    return summary;

  } catch (error) {
    console.error('\n❌ Social media posting failed:', error.message);
    throw error;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  postToSocialMedia,
  generateSocialContent,
  postToLinkedIn,
  postToFacebook,
  postToInstagram
};
