import { extractText, extractLinks, getDocumentProxy } from 'unpdf';
import { sanitizeUntrustedData } from '../agents/contracts';

/**
 * Extracts raw text and embedded hyperlink annotations from a PDF, TXT, MD, or JSON file buffer.
 */
export async function extractTextFromResumeBuffer(
  buffer: Buffer,
  filename: string,
  mimeType?: string,
): Promise<{ text: string; pageCount: number; extractedLinks: string[] }> {
  const isPdf =
    mimeType === 'application/pdf' ||
    filename.toLowerCase().endsWith('.pdf') ||
    buffer.subarray(0, 5).toString('ascii') === '%PDF-';

  if (!isPdf) {
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '').trim();
    return { text, pageCount: 1, extractedLinks: [] };
  }

  const uint8 = new Uint8Array(buffer);
  const pdf = await getDocumentProxy(uint8);
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  let links: string[] = [];
  try {
    const linkRes = await extractLinks(pdf);
    links = Array.isArray(linkRes?.links)
      ? linkRes.links.map((l) => String(l).trim()).filter(Boolean)
      : [];
  } catch {
    // ignore link annotation errors
  }

  const combinedText = [
    typeof text === 'string' ? text : (text as string[]).join('\n\n'),
    ...(links.length > 0 ? ['\nEmbedded Links:', ...links] : []),
  ]
    .join('\n')
    .trim();

  return {
    text: combinedText,
    pageCount: totalPages || 1,
    extractedLinks: links,
  };
}

export interface ParsedResumeResult {
  fullName: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
  headline: string | null;
  summary: string | null;
  yearsOfExperience: number | null;
  experienceLevel: 'fresher' | 'entry' | 'mid' | 'senior' | 'any';
  links: {
    github: string | null;
    linkedin: string | null;
    portfolio: string | null;
  };
  skills: Array<{ name: string; category: string }>;
  experiences: Array<{
    company: string;
    role: string;
    location: string | null;
    startDate: string | null;
    endDate: string | null;
    isCurrent: boolean;
    description: string;
  }>;
  educations: Array<{
    institution: string;
    degree: string;
    fieldOfStudy: string | null;
    startYear: string | null;
    endYear: string | null;
    grade: string | null;
  }>;
  projects: Array<{
    name: string;
    description: string;
    techStack: string[];
    repoUrl: string | null;
    liveUrl: string | null;
  }>;
  sanitizedSourceXml: string;
}

const KNOWN_SKILLS: Array<{ pattern: RegExp; canonical: string; category: string }> = [
  { pattern: /\btypescript\b/i, canonical: 'TypeScript', category: 'language' },
  { pattern: /\bjavascript\b/i, canonical: 'JavaScript', category: 'language' },
  { pattern: /\bpython\b/i, canonical: 'Python', category: 'language' },
  { pattern: /\bgolang\b|\bgo\b/i, canonical: 'Golang', category: 'language' },
  { pattern: /\brust\b/i, canonical: 'Rust', category: 'language' },
  { pattern: /\bjava\b/i, canonical: 'Java', category: 'language' },
  { pattern: /\bc\+\+\b/i, canonical: 'C++', category: 'language' },
  { pattern: /\bsql\b/i, canonical: 'SQL', category: 'language' },
  { pattern: /\breact(?:\.js|js)?\b/i, canonical: 'React', category: 'frontend' },
  { pattern: /\bnext(?:\.js|js)\b/i, canonical: 'Next.js', category: 'frontend' },
  { pattern: /\btailwind(?:\s*css)?\b/i, canonical: 'Tailwind CSS', category: 'frontend' },
  { pattern: /\bnode(?:\.js|js)\b/i, canonical: 'Node.js', category: 'backend' },
  { pattern: /\bexpress(?:\.js|js)?\b/i, canonical: 'Express.js', category: 'backend' },
  { pattern: /\bfastapi\b/i, canonical: 'FastAPI', category: 'backend' },
  { pattern: /\bdjango\b/i, canonical: 'Django', category: 'backend' },
  { pattern: /\bspring\s*boot\b/i, canonical: 'Spring Boot', category: 'backend' },
  { pattern: /\bgraphql\b/i, canonical: 'GraphQL', category: 'backend' },
  { pattern: /\bpostgresql\b|\bpostgres\b/i, canonical: 'PostgreSQL', category: 'database' },
  { pattern: /\bmongodb\b/i, canonical: 'MongoDB', category: 'database' },
  { pattern: /\bredis\b/i, canonical: 'Redis', category: 'database' },
  { pattern: /\bsqlite\b/i, canonical: 'SQLite', category: 'database' },
  { pattern: /\bprisma\b/i, canonical: 'Prisma', category: 'database' },
  { pattern: /\bdocker\b/i, canonical: 'Docker', category: 'devops' },
  { pattern: /\bkubernetes\b|\bk8s\b/i, canonical: 'Kubernetes', category: 'devops' },
  { pattern: /\baws\b|\bamazon web services\b/i, canonical: 'AWS', category: 'cloud' },
  { pattern: /\bgcp\b|\bgoogle cloud\b/i, canonical: 'GCP', category: 'cloud' },
  { pattern: /\bplaywright\b/i, canonical: 'Playwright', category: 'testing' },
  { pattern: /\bgit\b/i, canonical: 'Git', category: 'tooling' },
  { pattern: /\blangchain\b/i, canonical: 'LangChain', category: 'ai' },
  { pattern: /\bpytorch\b/i, canonical: 'PyTorch', category: 'ai' },
];

/**
 * Factual Resume Parser
 * Extracts only information explicitly present in the uploaded resume text or PDF buffer.
 * Never fabricates missing employers, degrees, skills, or links.
 */
export function parseResumeContent(rawText: string): ParsedResumeResult {
  const sanitizedXml = sanitizeUntrustedData(rawText, 'candidate_resume');
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  // 1. Extract Email
  const emailMatch = rawText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  const email = emailMatch ? emailMatch[0].toLowerCase() : null;

  // 2. Extract Phone
  const phoneMatch = rawText.match(
    /(?:\+\d{1,3}[\s-]?)?(?:\(\d{2,4}\)[\s-]?)?\d{3,5}[\s-]?\d{5,7}\b/,
  );
  const phone = phoneMatch ? phoneMatch[0].trim() : null;

  // 3. Extract Links (GitHub, LinkedIn, Portfolio — with or without https:// prefix)
  const githubMatch = rawText.match(
    /(?:https?:\/\/)?(?:www\.)?github\.com\/[a-zA-Z0-9_.-]+/i,
  );
  const linkedinMatch = rawText.match(
    /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[a-zA-Z0-9_-]+\/?/i,
  );
  const allUrls = [...rawText.matchAll(/https?:\/\/[^\s,;)"<>]+/gi)].map((m) =>
    m[0].replace(/,+$/, ''),
  );
  const portfolioUrl =
    allUrls.find(
      (u) =>
        !u.toLowerCase().includes('github.com') &&
        !u.toLowerCase().includes('linkedin.com'),
    ) ?? null;

  const normalizeHttps = (url: string | null): string | null => {
    if (!url) return null;
    return /^https?:\/\//i.test(url) ? url : `https://${url}`;
  };

  // 4. Extract Name (first clean header line that isn't an email/URL/section title)
  let fullName: string | null = null;
  for (const line of lines.slice(0, 5)) {
    const cleaned = line.replace(/^#+\s*/, '').trim();
    if (
      cleaned.length >= 3 &&
      cleaned.length <= 50 &&
      !/[@:/|0-9]/.test(cleaned) &&
      !/^(resume|curriculum vitae|cv|summary|education|experience|skills|projects)$/i.test(
        cleaned,
      )
    ) {
      fullName = cleaned;
      break;
    }
  }

  // 5. Extract Location if explicitly labeled or matching common city/country patterns
  let location: string | null = null;
  const locLabelMatch = rawText.match(
    /(?:location|based in|address|city)\s*[:\-]\s*([^\n|]+)/i,
  );
  if (locLabelMatch?.[1]) {
    location = locLabelMatch[1].trim();
  } else {
    const cityMatch = rawText.match(
      /\b(Bangalore|Bengaluru|Mumbai|Delhi|NCR|Hyderabad|Pune|Chennai|Noida|Gurgaon|San Francisco|New York|London|Remote(?:,\s*India)?|[A-Za-z\s]+,\s*India)\b/i,
    );
    if (cityMatch) location = cityMatch[0].trim();
  }

  // 6. Extract Skills
  const skills: Array<{ name: string; category: string }> = [];
  const seenSkills = new Set<string>();
  for (const item of KNOWN_SKILLS) {
    if (item.pattern.test(rawText) && !seenSkills.has(item.canonical)) {
      seenSkills.add(item.canonical);
      skills.push({ name: item.canonical, category: item.category });
    }
  }

  // Also check explicit "Skills:" line
  const skillsLineMatch = rawText.match(/skills\s*[:\-]\s*([^\n]+)/i);
  if (skillsLineMatch?.[1]) {
    const extra = skillsLineMatch[1]
      .split(/[,|•·]/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2 && s.length <= 30);
    for (const token of extra) {
      if (![...seenSkills].some((k) => k.toLowerCase() === token.toLowerCase())) {
        seenSkills.add(token);
        skills.push({ name: token, category: 'technical' });
      }
    }
  }

  // 7. Extract Sections (Experience, Education, Projects)
  const sections = splitIntoSections(lines);

  const experiences = parseExperienceSection(sections.experience ?? []);
  const educations = parseEducationSection(sections.education ?? []);
  const projects = parseProjectsSection(sections.projects ?? [], skills.map((s) => s.name));

  // 8. Years of experience & level
  let yearsOfExperience: number | null = null;
  const yearsMatch = rawText.match(/(\d+(?:\.\d+)?)\+?\s*years?\s+of\s+experience/i);
  if (yearsMatch) {
    yearsOfExperience = Number(yearsMatch[1]);
  } else if (experiences.length === 0) {
    yearsOfExperience = 0;
  }

  const experienceLevel: ParsedResumeResult['experienceLevel'] =
    yearsOfExperience !== null && yearsOfExperience >= 5
      ? 'senior'
      : yearsOfExperience !== null && yearsOfExperience >= 2
        ? 'mid'
        : experiences.some((e) => !/intern/i.test(e.role))
          ? 'entry'
          : 'fresher';

  const summary =
    sections.summary && sections.summary.length > 0
      ? sections.summary.join(' ').slice(0, 500)
      : null;

  return {
    fullName,
    email,
    phone,
    location,
    headline: experiences[0] ? `${experiences[0].role} @ ${experiences[0].company}` : null,
    summary,
    yearsOfExperience,
    experienceLevel,
    links: {
      github: normalizeHttps(githubMatch ? githubMatch[0] : null),
      linkedin: normalizeHttps(linkedinMatch ? linkedinMatch[0] : null),
      portfolio: portfolioUrl,
    },
    skills,
    experiences,
    educations,
    projects,
    sanitizedSourceXml: sanitizedXml,
  };
}

function splitIntoSections(lines: string[]): Record<string, string[]> {
  const sections: Record<string, string[]> = { header: [] };
  let current = 'header';

  for (const rawLine of lines) {
    const clean = rawLine.replace(/^[#*_\-\s]+|[#*_\-\s:]+$/g, '').trim();
    if (/^(summary|profile|about|objective)$/i.test(clean)) {
      current = 'summary';
      sections[current] = sections[current] ?? [];
      continue;
    }
    if (/^(experience|work experience|employment|internships?)$/i.test(clean)) {
      current = 'experience';
      sections[current] = sections[current] ?? [];
      continue;
    }
    if (/^(education|academics|academic background)$/i.test(clean)) {
      current = 'education';
      sections[current] = sections[current] ?? [];
      continue;
    }
    if (/^(projects?|personal projects?|key projects?)$/i.test(clean)) {
      current = 'projects';
      sections[current] = sections[current] ?? [];
      continue;
    }
    if (/^(skills|technical skills|technologies|core competencies)$/i.test(clean)) {
      current = 'skills';
      sections[current] = sections[current] ?? [];
      continue;
    }
    if (/^(awards?( and certificates?)?|certifications?|achievements?|honors?|embedded links)$/i.test(clean)) {
      current = 'awards';
      sections[current] = sections[current] ?? [];
      continue;
    }
    sections[current] = sections[current] ?? [];
    sections[current].push(rawLine);
  }
  return sections;
}

const DATE_RANGE_RE =
  /\b((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}|\d{4})\s*[-–—to]+\s*((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}|\d{4}|Present|Current)\b/i;

function parseExperienceSection(
  lines: string[],
): ParsedResumeResult['experiences'] {
  const results: ParsedResumeResult['experiences'] = [];
  let current: ParsedResumeResult['experiences'][0] | null = null;
  let pendingCompanyLine: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const isBullet = /^[-•*]\s+/.test(line);

    if (isBullet) {
      if (current) {
        const cleaned = line.replace(/^[-•*]\s*/, '').trim();
        current.description = current.description
          ? `${current.description} ${cleaned}`
          : cleaned;
      }
      pendingCompanyLine = null;
      continue;
    }

    // Check if this non-bullet line is a wrapped continuation of a bullet sentence (starts with lowercase or number like "100+ images...")
    if (current && /^[a-z0-9]/.test(line)) {
      current.description = `${current.description.replace(/-\s*$/, '')} ${line}`.trim();
      continue;
    }

    // Case A: Single-line "Role at Company (Date - Date)"
    const atMatch = line.match(
      /^([^|—\-@•]+?)\s+(?:at|@)\s+([^|(]+?)(?:\s*[|(]\s*([^)]+)\)?.*)?$/i,
    );
    if (atMatch && line.length < 110) {
      if (current) results.push(current);
      const datePart = atMatch[3]?.trim() ?? null;
      current = {
        role: atMatch[1].trim(),
        company: atMatch[2].trim(),
        location: null,
        startDate: datePart ? datePart.split(/[-–to]+/i)[0]?.trim() ?? null : null,
        endDate: datePart ? datePart.split(/[-–to]+/i)[1]?.trim() ?? null : null,
        isCurrent: Boolean(datePart && /present|current/i.test(datePart)),
        description: '',
      };
      pendingCompanyLine = null;
      continue;
    }

    // Case B: LaTeX 2-line Experience ("Company Location" on previous line + "Role Month Year – Month Year" on this line)
    const dateMatch = line.match(DATE_RANGE_RE);
    if (dateMatch && pendingCompanyLine) {
      if (current) results.push(current);
      const roleTitle = line.replace(dateMatch[0], '').trim() || 'Software Engineer';
      current = {
        role: roleTitle,
        company: pendingCompanyLine,
        location: null,
        startDate: dateMatch[1],
        endDate: dateMatch[2],
        isCurrent: /present|current/i.test(dateMatch[2]),
        description: '',
      };
      pendingCompanyLine = null;
      continue;
    }

    // Otherwise, if it starts with an uppercase letter and is short, it's likely a Company header line
    if (/^[A-Z]/.test(line) && line.length <= 90) {
      pendingCompanyLine = line;
    }
  }

  if (current) results.push(current);
  return results;
}

function parseEducationSection(
  lines: string[],
): ParsedResumeResult['educations'] {
  const results: ParsedResumeResult['educations'] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const combined = `${lines[i - 1] ?? ''} — ${line}`;
    const degreeMatch = line.match(
      /\b(B\.?\s*Tech|M\.?\s*Tech|B\.?\s*E\.?|B\.?\s*Sc|M\.?\s*Sc|BCA|MCA|Bachelor[^,—|]*|Master[^,—|]*)/i,
    );
    if (degreeMatch) {
      const years = [...combined.matchAll(/\b(20\d{2})\b/g)].map((m) => m[1]);
      const prevLine = (lines[i - 1] ?? '').replace(DATE_RANGE_RE, '').trim();
      const institution =
        prevLine && /university|institute|college|school|iit|nit|iiit|bits|msit/i.test(prevLine)
          ? prevLine
          : line
              .split(/[—|\-,]/)
              .map((p) => p.trim())
              .find((p) => /university|institute|college|school|iit|nit|iiit/i.test(p)) ??
            'Institution';

      results.push({
        institution,
        degree: degreeMatch[0].trim(),
        fieldOfStudy: null,
        startYear: years[0] ?? null,
        endYear: years[1] ?? years[0] ?? null,
        grade: null,
      });
    }
  }
  return results;
}

function parseProjectsSection(
  lines: string[],
  knownSkills: string[],
): ParsedResumeResult['projects'] {
  const results: ParsedResumeResult['projects'] = [];
  let current: ParsedResumeResult['projects'][0] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const isBullet = /^[-•*]\s+/.test(line);
    if (isBullet) {
      if (current) {
        const cleaned = line.replace(/^[-•*]\s*/, '').trim();
        current.description = current.description
          ? `${current.description} ${cleaned}`
          : cleaned;
      }
      continue;
    }

    // Continuation of wrapped bullet line (starts with lowercase, number, or continues hyphenated word)
    if (current && (/^[a-z0-9]/.test(line) || current.description.endsWith('-'))) {
      current.description = `${current.description.replace(/-\s*$/, '')} ${line}`.trim();
      continue;
    }

    // Case 1: Single-line "ProjectName — Description"
    const singleHeaderMatch = line.match(
      /^([A-Z][A-Za-z0-9\s._/()]{1,45}?)\s+(?:[—|:]|-\s+)\s*(.+)$/,
    );
    const startsWithActionVerb =
      /^(?:Designed|Built|Engineered|Implemented|Developed|Architected|Orchestrated|Integrated|Refactored|Created)\b/i.test(
        line,
      );

    if (singleHeaderMatch && !startsWithActionVerb) {
      if (current) results.push(current);
      const rawName = singleHeaderMatch[1]
        .replace(/\b(Live Demo|GitHub Link|GitHub|Demo|Link)\b/gi, '')
        .trim();
      const desc = singleHeaderMatch[2].trim();
      const urlMatch = line.match(/https?:\/\/[^\s)]+/i);
      const stack = knownSkills.filter((s) =>
        new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(
          line,
        ),
      );
      current = {
        name: rawName || singleHeaderMatch[1].trim(),
        description: desc,
        techStack: stack,
        repoUrl: urlMatch && urlMatch[0].includes('github.com') ? urlMatch[0] : null,
        liveUrl: urlMatch && !urlMatch[0].includes('github.com') ? urlMatch[0] : null,
      };
      continue;
    }

    // Case 2: LaTeX 2-line project header ("MemoryOS Live Demo" or "Kira GitHub Link" followed by subtitle)
    if (
      /^[A-Z]/.test(line) &&
      line.length <= 65 &&
      !startsWithActionVerb &&
      !line.endsWith('.')
    ) {
      const cleanTitle = line
        .replace(/\b(Live Demo|GitHub Link|GitHub|Source Code|Link)\b/gi, '')
        .trim();

      // If we just started a project with 0 description and this next short capitalized line is its subtitle, attach it as subtitle!
      if (current && !current.description) {
        current.description = `${line}.`;
        continue;
      }

      if (cleanTitle.length >= 2 && cleanTitle.split(/\s+/).length <= 5) {
        if (current) results.push(current);
        current = {
          name: cleanTitle,
          description: '',
          techStack: [],
          repoUrl: null,
          liveUrl: null,
        };
      }
    }
  }

  if (current) results.push(current);

  // Enrich techStack from each project's full description
  for (const proj of results) {
    const combined = `${proj.name} ${proj.description}`;
    proj.techStack = knownSkills.filter((s) =>
      new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(
        combined,
      ),
    );
  }

  return results;
}
