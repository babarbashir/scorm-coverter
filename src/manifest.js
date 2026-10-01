'use strict';

// Builds imsmanifest.xml for SCORM 1.2, 2004 3rd Edition and 2004 4th Edition.
// Structure mirrors what mainstream authoring tools emit (single organization,
// single SCO) because that is the shape every LMS importer is tested against.

const VERSIONS = {
  '1.2': { label: 'SCORM 1.2', schemaDir: 'scorm12' },
  '2004-3': { label: 'SCORM 2004 3rd Edition', schemaDir: 'scorm2004-3', schemaversion: '2004 3rd Edition' },
  '2004-4': { label: 'SCORM 2004 4th Edition', schemaDir: 'scorm2004-4', schemaversion: '2004 4th Edition' },
};

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Strip characters that are illegal in XML 1.0.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
}

// xs:ID values must start with a letter/underscore and contain no spaces.
function toXmlId(s) {
  const id = String(s).replace(/[^A-Za-z0-9_.-]/g, '_');
  return /^[A-Za-z_]/.test(id) ? id : `ID_${id}`;
}

function fileList(files) {
  return files.map((f) => `      <file href="${xmlEscape(f)}"/>`).join('\n');
}

function manifest12({ id, title, files, launch = 'index.html' }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="${toXmlId(id)}" version="1.0"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd http://www.imsglobal.org/xsd/imsmd_rootv1p2p1 imsmd_rootv1p2p1.xsd http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="ORG_1">
    <organization identifier="ORG_1">
      <title>${xmlEscape(title)}</title>
      <item identifier="ITEM_1" identifierref="RES_1" isvisible="true">
        <title>${xmlEscape(title)}</title>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES_1" type="webcontent" adlcp:scormtype="sco" href="${xmlEscape(launch)}">
${fileList(files)}
    </resource>
  </resources>
</manifest>
`;
}

function manifest2004({ id, title, files, launch = 'index.html', schemaversion }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="${toXmlId(id)}" version="1"
  xmlns="http://www.imsglobal.org/xsd/imscp_v1p1"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3"
  xmlns:adlseq="http://www.adlnet.org/xsd/adlseq_v1p3"
  xmlns:adlnav="http://www.adlnet.org/xsd/adlnav_v1p3"
  xmlns:imsss="http://www.imsglobal.org/xsd/imsss"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsglobal.org/xsd/imscp_v1p1 imscp_v1p1.xsd http://www.adlnet.org/xsd/adlcp_v1p3 adlcp_v1p3.xsd http://www.adlnet.org/xsd/adlseq_v1p3 adlseq_v1p3.xsd http://www.adlnet.org/xsd/adlnav_v1p3 adlnav_v1p3.xsd http://www.imsglobal.org/xsd/imsss imsss_v1p0.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>${schemaversion}</schemaversion>
  </metadata>
  <organizations default="ORG_1">
    <organization identifier="ORG_1">
      <title>${xmlEscape(title)}</title>
      <item identifier="ITEM_1" identifierref="RES_1" isvisible="true">
        <title>${xmlEscape(title)}</title>
        <imsss:sequencing>
          <imsss:deliveryControls completionSetByContent="true" objectiveSetByContent="true"/>
        </imsss:sequencing>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES_1" type="webcontent" adlcp:scormType="sco" href="${xmlEscape(launch)}">
${fileList(files)}
    </resource>
  </resources>
</manifest>
`;
}

function buildManifest(version, opts) {
  const v = VERSIONS[version];
  if (!v) throw new Error(`Unknown SCORM version: ${version}`);
  // SCORM 1.2 caps <title> at 200 characters; keep both versions consistent.
  const title = String(opts.title || 'Untitled').trim().slice(0, 200) || 'Untitled';
  return version === '1.2'
    ? manifest12({ ...opts, title })
    : manifest2004({ ...opts, title, schemaversion: v.schemaversion });
}

module.exports = { VERSIONS, buildManifest, xmlEscape, toXmlId };
