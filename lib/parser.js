// Re-export unified parser for backward compatibility.
const issueParser = require('./issueParser');

module.exports = {
  parseBlinterOutput: issueParser.parseOutput,
  mapSeverityFromLegacy: issueParser.mapSeverityFromLegacy,
  mapSeverityFromCode: issueParser.severityFromCode
};
