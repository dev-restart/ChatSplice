# Trail Notes

This is the hiking planner from the ChatSplice video. Copy this folder to a new location and register that copy in ChatSplice. Use Node.js 24 to run the tests and the local preview.

1. Ask ChatGPT to change the title in `src/welcome.js` to “Plan your next hike” and run `npm test`.
2. Open `src/welcome.js` in the editor and check the result under **History**. The heading test expects the new title, so it fails before the edit. After the edit, both tests should pass.
3. Run `node preview.mjs` in the copied folder and open the local URL it prints. The browser should show **Plan your next hike**. Stop the preview with Control+C.

## 한국어

영상에 나온 등산 계획 프로젝트입니다. 이 폴더를 새 위치에 복사한 뒤 복사본을 ChatSplice에 등록하세요. Node.js 24로 테스트와 미리보기를 실행할 수 있습니다.

1. ChatGPT에 `src/welcome.js`의 제목을 “Plan your next hike”로 바꾸고 `npm test`를 실행해 달라고 요청합니다.
2. 에디터에서 파일을 열고 **작업기록**에서 결과를 확인합니다. 제목 테스트는 바뀐 제목을 확인하므로 수정 전에는 실패합니다. 수정 후에는 두 테스트가 모두 통과해야 합니다.
3. 복사한 폴더에서 `node preview.mjs`를 실행하고 표시된 로컬 주소를 엽니다. **Plan your next hike**가 보이면 Control+C로 미리보기를 종료합니다.
