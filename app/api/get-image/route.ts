import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const { query, width = 800, height = 600, count = 1 } = await request.json();

    if (!query) {
      return NextResponse.json(
        { success: false, error: 'Image query is required' },
        { status: 400 }
      );
    }

    const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;
    
    if (UNSPLASH_ACCESS_KEY) {
      try {
        const searchUrl = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=${count}&orientation=landscape`;
        const response = await fetch(searchUrl, {
          headers: {
            'Authorization': `Client-ID ${UNSPLASH_ACCESS_KEY}`,
          },
        });

        if (response.ok) {
          const data = await response.json();
          if (data.results && data.results.length > 0) {
            const images = data.results.slice(0, count).map((photo: any) => ({
              url: photo.urls.regular,
              thumb: photo.urls.thumb,
              full: photo.urls.full,
              description: photo.description || photo.alt_description || query,
            }));
            return NextResponse.json({
              success: true,
              images,
              source: 'unsplash',
            });
          }
        }
      } catch (error) {
        console.error('[get-image] Unsplash API error:', error);
      }
    }

    const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
    
    if (PEXELS_API_KEY) {
      try {
        const searchUrl = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${count}&orientation=landscape`;
        const response = await fetch(searchUrl, {
          headers: {
            'Authorization': PEXELS_API_KEY,
          },
        });

        if (response.ok) {
          const data = await response.json();
          if (data.photos && data.photos.length > 0) {
            const images = data.photos.slice(0, count).map((photo: any) => ({
              url: photo.src.large,
              thumb: photo.src.medium,
              full: photo.src.original,
              description: photo.photographer || query,
            }));
            return NextResponse.json({
              success: true,
              images,
              source: 'pexels',
            });
          }
        }
      } catch (error) {
        console.error('[get-image] Pexels API error:', error);
      }
    }

    return NextResponse.json({
      success: true,
      images: [
        {
          url: `https://source.unsplash.com/${width}x${height}/?${encodeURIComponent(query)}`,
          description: query,
        }
      ],
      source: 'unsplash-source',
    });

  } catch (error: any) {
    console.error('[get-image] Error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to fetch image' },
      { status: 500 }
    );
  }
}

