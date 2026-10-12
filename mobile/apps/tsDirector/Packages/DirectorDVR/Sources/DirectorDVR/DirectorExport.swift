// The archive index and the export that stitches a recording's segments into finished files live
// in `DirectorExport`, shared with the Mac. Re-exported so `import DirectorDVR` still sees them.
@_exported import DirectorExport
// The live session's resume plan moved to `DirectorMedia` with the recorder it resumes.
@_exported import DirectorMedia
