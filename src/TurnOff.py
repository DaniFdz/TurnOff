import os
import sys
from sys import platform
import time
from playsound import playsound
from flet import app, IconButton, Page, Column, Row, Text, icons


def play_sound():
    if os.path.exists(os.path.join(os.path.dirname(__file__), "notification.mp3")):
        playsound(os.path.join(os.path.dirname(__file__), "notification.mp3"))


class App:
    turned_off = False

    def __init__(self):
        self.finish = time.time() + 60 * 30
        if platform != "win32" and os.geteuid() != 0:
            print("This script requires elevated privileges. Relaunching with sudo...")
            # Relaunch the script with sudo
            try:
                if sys.argv[0][-3:] == ".py":
                    os.execv(
                        "/usr/bin/osascript",
                        [
                            "osascript",
                            "-e",
                            f'do shell script "python3 {" ".join(sys.argv)}" with administrator privileges',
                        ],
                    )
                else:
                    os.execv(
                        "/usr/bin/osascript",
                        [
                            "osascript",
                            "-e",
                            f'do shell script "{" ".join(sys.argv)}" with administrator privileges',
                        ],
                    )

            except Exception as e:
                print(f"Failed to relaunch script with sudo: {e}")
                sys.exit(1)

        play_sound()
        app(target=self.main, port=8080)

    def main(self, page: Page):
        page.vertical_alignment = "center"
        page.horizontal_alignment = "center"
        page.window_width = 200
        page.window_height = 200
        page.window_resizable = False
        page.bgcolor = "#282934"
        page.window_opacity = 0.9

        t = self.finish - time.time()
        txt_number = Text(value="0", text_align="center", width=200, size=40)

        def add_click(e):
            self.finish += 60 * 5
            page.update()

        def subs_click(e):
            self.finish -= 60 * 5
            page.update()

        def shutdown_alert():
            if not self.turned_off:
                play_sound()
                page.add(
                    Text(
                        value="The computer will turn off in 1 minute",
                        text_align="center",
                        width=150,
                        size=20,
                    )
                )
                page.remove_at(0)
                self.turned_off = True

        def shutdown():
            if platform == "win32":
                os.system("shutdown /s /t 1")
            elif platform == "linux" or platform == "linux2":
                os.system("sudo shutdown now")
            elif platform == "darwin":
                os.system("sudo shutdown -h now")

        page.add(
            Column(
                [
                    txt_number,
                    Row(
                        [
                            Column(
                                [
                                    IconButton(icons.ADD, on_click=add_click),
                                    Text(value="5m", width=90, size=20),
                                ],
                                alignment="center",
                            ),
                            Column(
                                [
                                    IconButton(icon=icons.REMOVE, on_click=subs_click),
                                    Text(value="5m", width=90, size=20),
                                ],
                                alignment="center",
                            ),
                        ],
                        alignment="center",
                    ),
                ],
                alignment="center",
            )
        )
        while True:
            t = self.finish - time.time()
            txt_number.value = (
                f"{int(t//60)}:{int(t%60)}"
                if t % 60 > 10
                else f"{int(t//60)}:0{int(t%60)}"
            )
            if t <= 0:
                shutdown_alert()
            if t < -60:
                shutdown()

            page.update()

    def not_windows(self, page: Page):
        page.vertical_alignment = "center"
        page.horizontal_alignment = "center"
        page.window_width = 200
        page.window_height = 150
        page.window_resizable = False
        page.bgcolor = "#282934"
        page.window_opacity = 0.9

        page.add(
            Text(
                value="This app is only for Windows",
                text_align="center",
                width=150,
                size=20,
            )
        )

        time.sleep(10)
        page.window_close()


if __name__ == "__main__":
    App()
