import os, time
from flet import app, IconButton, Page, Column, Row, Text, icons
from sys import platform

class App:
    def __init__(self):
        self.finish = time.time()+60*30
        if platform == "win32":
            app(target=self.main, port=8080)
        else:
            app(target=self.not_windows)

    def main(self, page: Page):
        page.vertical_alignment = "center"
        page.horizontal_alignment = "center"
        page.window_width = 200
        page.window_height = 200
        page.window_resizable = False
        page.bgcolor="#282934"
        page.window_opacity=.9

        t = self.finish-time.time()
        txt_number = Text(value="0", text_align="center", width=150, size=40)

        def plus_click(e):
            self.finish+=60*30
            page.update()

        page.add(
            Column(
                [
                    txt_number,
                    Row([IconButton(icons.ADD,on_click=plus_click), Text(value="30mins", width=90, size=20)]),
                ],
                alignment="center"
            )
        )
        while True:
            t = self.finish-time.time()
            txt_number.value = f'{int(t//60)}:{int(t%60)}' if t%60 > 10 else f'{int(t//60)}:0{int(t%60)}'
            if(t <= 0):
                os.system("shutdown /s /t 15")
                break
            page.update()
        page.window_close()

    def not_windows(self, page: Page):
        page.vertical_alignment = "center"
        page.horizontal_alignment = "center"
        page.window_width = 200
        page.window_height = 150
        page.window_resizable = False
        page.bgcolor="#282934"
        page.window_opacity=.9

        page.add(
            Text(value="This app is only for Windows", text_align="center", width=150, size=20)
        )

        time.sleep(10)
        page.window_close()

if __name__ == '__main__':
    App()
