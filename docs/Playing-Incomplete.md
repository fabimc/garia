# Playing a download before it finishes

**Download in order** in Settings switches aria2's piece selector to `inorder`, so a file fills from the beginning instead of wherever a connection happens to be. It is off by default and it is a real trade — the default selector picks pieces to keep connections busy, which is what makes the download fast — and aria2 will not change it on a download already in flight, so it rides on each one as it is added.

A row's detail panel then says how much of the *front* of the file is on disk, and offers to open it. That number comes from aria2's piece bitfield rather than from `completedLength`: a download can be 90% complete with a hole at the beginning, and a percentage would call that playable. What is counted is the contiguous run of pieces from piece zero.

Having the bytes still isn't enough for MP4 and its relatives, which carry an index — the `moov` box — that a player has to read before it can start, and which plenty of encoders write *after* the video. So Garia walks the file's top-level boxes as far as the bytes actually go, and only offers to play it once the whole index is there. Matroska, WebM, Ogg and MPEG-TS are built to be read from the first byte and need no such check. (Garia's own merged videos are written with `+faststart`, which puts the index in front — so a merged download is playable as soon as it starts arriving.)
