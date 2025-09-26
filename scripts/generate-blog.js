const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const yaml = require('js-yaml');

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const POSTS_DIR = 'Posts';

// Your exact YAML format
const BLOG_TEMPLATE = {
  title: "",
  slug: "",
  excerpt: "",
  content: "",
  author: "LimitBreakIT Team",
  publishedAt: "",
  readTime: "",
  category: "Technology",
  tags: [],
  featured: false,
  image: "",
  metaTitle: "",
  metaDescription: "",
  keywords: []
};

async function getTechTrends() {
  try {
    console.log('🔍 Researching latest tech trends...');
    
    const response = await axios.post('https://api.perplexity.ai/chat/completions', {
      model: "sonar",
      messages: [
        {
          role: "system",
          content: `You are an expert tech writer for LimitBreakIT, a Malta-based IT consultancy. 
          Create engaging, SEO-optimized blog content about current tech trends.
          Focus on: AI, cybersecurity, cloud computing, software development, automation, business technology.
          Target audience: IT managers, business owners, tech professionals in Malta and Europe.
          
          CRITICAL: Your response must be ONLY valid JSON. No additional text, explanations, or markdown formatting.`
        },
        {
          role: "user",
          content: `Research the latest technology trends from the past 24-48 hours. Find 1 compelling, current topic.

Create a complete blog post as JSON with these EXACT fields:

{
  "title": "Catchy title (max 60 characters)",
  "slug": "url-friendly-slug",
  "excerpt": "Compelling summary in 2-3 sentences (max 200 words)",
  "content": "Full blog post in markdown format (1200-1800 words). Include practical examples, statistics, and actionable insights. Write professionally but engagingly.",
  "tags": ["5-7 relevant tags"],
  "metaTitle": "SEO title (max 60 chars)",
  "metaDescription": "SEO description (max 160 chars)",
  "keywords": ["5-8 SEO keywords"],
  "category": "Choose from: Technology, Cybersecurity, Cloud Computing, AI, Software Development",
  "image": "/images/[slug].jpg"
}

Make it highly relevant to current events and practical for business use.
Ensure content is original, informative, and engaging.
Focus on trends that affect businesses and IT decision-makers.`
        }
      ],
      temperature: 0.7,
      max_tokens: 4000
    }, {
      headers: {
        'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    console.log('🔍 API Response received, analyzing structure...');
    
    // Debug logging
    if (response.data) {
      console.log('📊 Response structure:', {
        status: response.status,
        hasData: !!response.data,
        dataKeys: Object.keys(response.data),
        hasChoices: !!response.data.choices,
        choicesLength: response.data.choices ? response.data.choices.length : 0
      });
    }

    // FIX: Correct path to access content
    let content = '';
    if (response.data && response.data.choices && response.data.choices[0] && response.data.choices[0].message) {
      content = response.data.choices[0].message.content;
      console.log('✅ Successfully extracted content from response');
    } else {
      throw new Error('Unexpected API response structure');
    }

    if (!content) {
      throw new Error('Empty content received from API');
    }

    console.log('📝 Raw content received, attempting to parse...');
    
    // Clean the response and extract JSON
    let cleanContent = content.trim();
    
    // Remove markdown code blocks if present
    cleanContent = cleanContent.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    
    // Find JSON object
    const jsonMatch = cleanContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('❌ No JSON found in content:', cleanContent.substring(0, 500));
      throw new Error('No JSON object found in response');
    }
    
    const parsedContent = JSON.parse(jsonMatch[0]);
    console.log('✅ Successfully parsed blog content');
    console.log(`📰 Title: ${parsedContent.title}`);
    
    return parsedContent;
    
  } catch (error) {
    console.error('❌ Error fetching tech trends:', error.message);
    if (error.response) {
      console.error('API Response Status:', error.response.status);
      console.error('API Response Data:', JSON.stringify(error.response.data, null, 2));
    }
    
    // Fallback content generation
    console.log('🔄 Using fallback content generation...');
    return generateFallbackContent();
  }
}

function generateFallbackContent() {
  const topics = [
    {
      title: "AI Transforms Business Operations in 2025",
      category: "AI",
      focus: "artificial intelligence, automation, productivity"
    },
    {
      title: "Zero Trust Security: The New Standard",
      category: "Cybersecurity",
      focus: "security, zero trust, enterprise protection"
    },
    {
      title: "Cloud Native Development Trends",
      category: "Cloud Computing",
      focus: "cloud, kubernetes, microservices"
    }
  ];
  
  const topic = topics[Math.floor(Math.random() * topics.length)];
  const slug = generateSlug(topic.title);
  
  return {
    title: topic.title,
    slug: slug,
    excerpt: `Exploring the latest developments in ${topic.focus} and their impact on modern businesses. Learn how these technologies are reshaping the IT landscape.`,
    content: `## Introduction\n\nThe technology landscape continues to evolve rapidly, bringing new opportunities and challenges for businesses.\n\n## Key Trends\n\nRecent developments show significant progress in ${topic.focus}.\n\n## Business Impact\n\nOrganizations are leveraging these technologies to improve efficiency and competitive advantage.\n\n## Best Practices\n\n1. Start with a clear strategy\n2. Focus on measurable outcomes\n3. Invest in team training\n\n## Conclusion\n\nStaying ahead of technology trends is crucial for business success in 2025.`,
    tags: topic.focus.split(", "),
    metaTitle: topic.title,
    metaDescription: `Learn about ${topic.focus} trends shaping business technology in 2025.`,
    keywords: topic.focus.split(", "),
    category: topic.category,
    image: `/images/${slug}.jpg`
  };
}

function calculateReadTime(content) {
  const wordsPerMinute = 200;
  const words = content.trim().split(/\s+/).length;
  const minutes = Math.ceil(words / wordsPerMinute);
  return `${minutes} min read`;
}

function generateSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 50);
}

async function checkForDuplicates(slug) {
  try {
    const files = await fs.readdir(POSTS_DIR);
    return files.some(file => file.includes(slug));
  } catch (error) {
    console.log('📁 Posts directory not found, creating...');
    await fs.mkdir(POSTS_DIR, { recursive: true });
    return false;
  }
}

async function generateBlogPost() {
  try {
    const trendsData = await getTechTrends();
    
    // Create final slug and check for duplicates
    let finalSlug = trendsData.slug || generateSlug(trendsData.title);
    
    if (await checkForDuplicates(finalSlug)) {
      const timestamp = new Date().toISOString().split('T')[0];
      finalSlug = `${finalSlug}-${timestamp}`;
      console.log(`🔄 Duplicate found, using: ${finalSlug}`);
    }
    
    // Create complete blog post object
    const blogPost = {
      ...BLOG_TEMPLATE,
      ...trendsData,
      slug: finalSlug,
      publishedAt: new Date().toISOString(),
      readTime: calculateReadTime(trendsData.content),
      image: trendsData.image || `/images/${finalSlug}.jpg`
    };

    // Validate required fields
    if (!blogPost.title || !blogPost.content || !blogPost.excerpt) {
      throw new Error('Missing required blog post fields');
    }

    // Generate YAML frontmatter
    const frontMatter = yaml.dump(blogPost, { 
      noRefs: true,
      quotingType: '"',
      forceQuotes: false,
      lineWidth: -1
    });
    
    // Create full markdown content
    const markdownContent = `---\n${frontMatter}---\n\n${blogPost.content}`;

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const fileName = `${timestamp}-${finalSlug}.md`;
    const filePath = path.join(POSTS_DIR, fileName);
    
    // Write file
    await fs.writeFile(filePath, markdownContent, 'utf8');
    
    console.log('🎉 Blog post created successfully!');
    console.log(`📁 File: ${fileName}`);
    console.log(`📰 Title: ${blogPost.title}`);
    console.log(`🏷️  Category: ${blogPost.category}`);
    console.log(`📊 Read time: ${blogPost.readTime}`);
    console.log(`🏃‍♂️ Word count: ~${trendsData.content.split(' ').length} words`);
    
    return filePath;
    
  } catch (error) {
    console.error('💥 Error generating blog post:', error);
    process.exit(1);
  }
}

// Execute the script
async function main() {
  console.log('🚀 Starting automated blog generation...');
  console.log(`📅 Date: ${new Date().toISOString()}`);
  
  try {
    await generateBlogPost();
    console.log('✅ Blog generation completed successfully!');
  } catch (error) {
    console.error('❌ Blog generation failed:', error.message);
    process.exit(1);
  }
}

// Run if this is the main module
if (require.main === module) {
  main();
}
