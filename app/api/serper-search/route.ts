import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const q: string | undefined = typeof body.q === 'string' ? body.q : undefined;
    const queries: string[] = Array.isArray(body.queries) ? body.queries.filter((s: any) => typeof s === 'string' && s.trim()) : [];
    const includeKeywords: string[] = Array.isArray(body.includeKeywords) ? body.includeKeywords.filter((s: any) => typeof s === 'string' && s.trim()) : [];
    const excludeKeywords: string[] = Array.isArray(body.excludeKeywords) ? body.excludeKeywords.filter((s: any) => typeof s === 'string' && s.trim()) : [];
    const gl: string = typeof body.gl === 'string' && body.gl ? body.gl : 'in';
    const hl: string = typeof body.hl === 'string' && body.hl ? body.hl : 'en';
    const candidateQueries: string[] = queries.length ? queries : (q ? [q] : []);
    if (!candidateQueries.length) {
      return NextResponse.json({ success: false, error: 'q or queries is required' }, { status: 400 });
    }

    const apiKey = process.env.SERPER_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ success: false, error: 'SERPER_API_KEY missing' }, { status: 400 });
    }

    const allCandidates: { url: string; query: string }[] = [];
    for (const query of candidateQueries) {
      const payload = { q: query, num: 10, gl, hl } as any;
      const resp = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: {
          'X-API-KEY': apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      if (!resp.ok) {
        continue;
      }
      const data = await resp.json();
      const add = (u?: string) => {
        if (u && typeof u === 'string' && /^https?:\/\//i.test(u)) allCandidates.push({ url: u, query });
      };
      (data.organic || []).forEach((r: any) => add(r.link));
      (data.news || []).forEach((r: any) => add(r.link));
      (data.answerBox ? [data.answerBox.link] : []).forEach(add);
    }

    const kwPass = (u: string) => {
      const text = u.toLowerCase();
      const includes = includeKeywords.length === 0 || includeKeywords.every(k => text.includes(k.toLowerCase()));
      const excludes = excludeKeywords.some(k => text.includes(k.toLowerCase()));
      return includes && !excludes;
    };

    const picked = allCandidates.find(c => kwPass(c.url)) || allCandidates[0] || null;
    return NextResponse.json({ success: true, url: picked?.url || null, tried: candidateQueries.length, candidates: allCandidates.slice(0, 10) });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message || 'search failed' }, { status: 500 });
  }
}


